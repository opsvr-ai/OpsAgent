/**
 * 访问关系自动打标签分类器（大模型建议 + 确定性规则兜底）。
 *
 * 数据流：
 *   访问关系摘要（relationKey / 主机 / 端口 / 服务 / product / tier / protocol）
 *     → prompt（≤80 条、≤12k 字符，不含敏感数据）
 *     → ModelCompletionService.complete({ json: true, maxTokens: 2200, timeoutMs: 60_000 })
 *     → 严格 JSON 解析：category 白名单、confidence 夹取、relationKey 必须来自输入
 *     → EdgeTagSuggestion[]（source='model'）
 *   模型失败（未配置/超时/HTTP/JSON 非法/空 suggestions）→ 规则引擎：
 *     运维端口 → 运维工具；外部 tier → 外部依赖；数据库/存储产品 → 数据访问；
 *     缓存/消息/注册中心产品 → 中间件访问；其余 → 应用调用（source='rule'）。
 *
 * 设计约束：
 *   - 每次最多处理 80 条（按输入顺序，relationKey 去重）；
 *   - prompt 只含关系摘要字段，不含命令、IP、异常等敏感数据；
 *   - 模型返回的非法项被过滤/归一化，同 relationKey 只保留最高置信度；
 *   - 失败时 warning 记录具体原因（≤200 字符）并 console.warn，风格与 topology_analyzer 一致。
 */
import type { EdgeTagSuggestion } from '@opsagent/contracts';
import type { ModelCompletionService } from '../models/completion.js';

export interface EdgeClassificationInput {
  readonly relationKey: string;
  readonly sourceHost: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly sourceService?: string;
  readonly targetProduct?: string;
  readonly targetTier?: string;
  readonly protocol?: string;
}

export interface EdgeClassifierResult {
  readonly suggestions: EdgeTagSuggestion[];
  readonly model: string;
  readonly fallback: boolean;
  readonly warning?: string;
}

/** 标签类别白名单（与产品/Web 侧约定一致）。 */
export const EDGE_TAG_CATEGORIES = [
  '运维工具',
  '应用调用',
  '数据访问',
  '中间件访问',
  '外部依赖',
  '其他',
] as const;

export type EdgeTagCategory = (typeof EDGE_TAG_CATEGORIES)[number];

const MODEL_LABEL = 'llm';
const FALLBACK_MODEL_LABEL = 'heuristic';
const MAX_EDGES = 80;
const MAX_PROMPT_CHARS = 12_000;
const MAX_LABEL_CHARS = 40;
const MAX_REASON_CHARS = 120;
const MAX_WARNING_CHARS = 200;

/** 运维/监控类端口（规则兜底）。 */
const OPS_PORTS = new Set<number>([22, 10050, 10051, 9100, 9090, 3000]);

const DATA_PATTERN =
  /(mysql|mariadb|postgres|postgresql|oracle|mongo|clickhouse|elasticsearch|opensearch|sqlserver|mssql|tidb|oceanbase|dameng)/i;

const MIDDLEWARE_PATTERN =
  /(redis|memcached|kafka|rabbitmq|rocketmq|activemq|pulsar|nacos|zookeeper|etcd|consul|eureka)/i;

/** 常见别名 → 白名单类别；未知值归入「其他」。 */
const CATEGORY_ALIASES: Record<string, EdgeTagCategory> = {
  '运维工具': '运维工具',
  ops: '运维工具',
  运维: '运维工具',
  monitoring: '运维工具',
  '应用调用': '应用调用',
  application: '应用调用',
  app: '应用调用',
  应用: '应用调用',
  service: '应用调用',
  '数据访问': '数据访问',
  database: '数据访问',
  data: '数据访问',
  数据: '数据访问',
  storage: '数据访问',
  '中间件访问': '中间件访问',
  middleware: '中间件访问',
  中间件: '中间件访问',
  cache: '中间件访问',
  mq: '中间件访问',
  '外部依赖': '外部依赖',
  external: '外部依赖',
  外部: '外部依赖',
  '其他': '其他',
  other: '其他',
  unknown: '其他',
};

const EDGE_TAG_SYSTEM_PROMPT = [
  '你是 OpsAgent 的访问关系分类器。根据访问关系的源/目标主机、端口、服务、目标 product/tier、协议，为每条关系建议一个中文可读标签。',
  '',
  '只输出严格 JSON 对象，不要 Markdown 围栏，不要解释：',
  '{"suggestions":[{"relationKey":"...","label":"...","category":"运维工具|应用调用|数据访问|中间件访问|外部依赖|其他","confidence":0.8,"reason":"..."}]}',
  '',
  '规则：',
  '1. relationKey 必须原样来自输入；每条输入建议一条，不要编造 relationKey。',
  '2. category 只能是：运维工具 / 应用调用 / 数据访问 / 中间件访问 / 外部依赖 / 其他。',
  '3. label 是该类别的可读短名（≤20 字），例如「运维工具」「MySQL 数据访问」「外部 API」「Kafka 消息队列」。',
  '4. confidence 取 0~1，表示判断把握；reason ≤80 字。',
  '5. 分类参考：端口 22/10050/10051/9100/9090/3000、prometheus/zabbix/node_exporter 等 → 运维工具；targetTier=external → 外部依赖；mysql/postgres/oracle/mongo/clickhouse/elasticsearch → 数据访问；redis/kafka/rabbitmq/nacos/zookeeper → 中间件访问；其余 HTTP/RPC 应用调用 → 应用调用。',
  '6. 只依据输入中的关系摘要判断，禁止编造字段或访问关系。',
].join('\n');

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function trimText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizePort(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const port = Math.trunc(value);
    return port > 0 && port <= 65_535 ? port : 0;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const port = Number.parseInt(value.trim(), 10);
    return port > 0 && port <= 65_535 ? port : 0;
  }
  return 0;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message;
    return error.name || 'unknown_error';
  }
  return valueToString(error) || 'unknown_error';
}

function valueToString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function normalizeCategory(value: unknown): EdgeTagCategory {
  const raw = trimText(value, 40);
  if (!raw) return '其他';
  if ((EDGE_TAG_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as EdgeTagCategory;
  }
  return CATEGORY_ALIASES[raw.toLowerCase()] ?? '其他';
}

/** 从模型回答中提取 JSON（兼容 ```json 围栏 / 前后解释文本 / 对象或数组根）。 */
function extractJsonPayload(answer: string): unknown {
  const trimmed = answer.trim();
  if (!trimmed) throw new Error('model_empty_response');
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      // 尝试下一个候选片段。
    }
  }
  throw new Error('model_json_invalid');
}

// ---------------------------------------------------------------------------
// 输入归一化与 prompt
// ---------------------------------------------------------------------------

interface NormalizedEdge {
  relationKey: string;
  sourceHost: string;
  targetHost: string;
  targetPort: number;
  sourceService: string;
  targetProduct: string;
  targetTier: string;
  protocol: string;
}

function normalizeEdges(edges: readonly EdgeClassificationInput[]): NormalizedEdge[] {
  const seen = new Set<string>();
  const output: NormalizedEdge[] = [];
  for (const edge of edges) {
    if (!edge || typeof edge.relationKey !== 'string') continue;
    const relationKey = edge.relationKey.trim();
    if (!relationKey || seen.has(relationKey)) continue;
    seen.add(relationKey);
    output.push({
      relationKey,
      sourceHost: trimText(edge.sourceHost, 120),
      targetHost: trimText(edge.targetHost, 120),
      targetPort: normalizePort(edge.targetPort),
      sourceService: trimText(edge.sourceService, 80),
      targetProduct: trimText(edge.targetProduct, 80),
      targetTier: trimText(edge.targetTier, 40),
      protocol: trimText(edge.protocol, 20),
    });
    if (output.length >= MAX_EDGES) break;
  }
  return output;
}

function promptEdge(edge: NormalizedEdge): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    relationKey: edge.relationKey,
    sourceHost: edge.sourceHost,
    targetHost: edge.targetHost,
    targetPort: edge.targetPort,
  };
  if (edge.sourceService) summary.sourceService = edge.sourceService;
  if (edge.targetProduct) summary.targetProduct = edge.targetProduct;
  if (edge.targetTier) summary.targetTier = edge.targetTier;
  if (edge.protocol) summary.protocol = edge.protocol;
  return summary;
}

function renderEdgePrompt(edges: readonly NormalizedEdge[]): string {
  return [
    '请给下面每条访问关系建议中文标签（category 限 运维工具/应用调用/数据访问/中间件访问/外部依赖/其他；relationKey 必须来自输入）。',
    '',
    '访问关系（JSON 数组）：',
    JSON.stringify(edges.map(promptEdge)),
    '',
    '只输出 JSON 对象，不要 Markdown 围栏或解释。',
  ].join('\n');
}

/**
 * 构造 prompt，并按 12k 字符上限确定性裁剪（从末尾移除关系，至少保留 1 条）。
 * 极端情况下单条关系也超限时抛错，走规则兜底。
 */
function buildEdgePrompt(edges: readonly NormalizedEdge[]): {
  readonly prompt: string;
  readonly included: NormalizedEdge[];
} {
  let included = edges.slice(0, MAX_EDGES);
  let prompt = renderEdgePrompt(included);
  while (prompt.length > MAX_PROMPT_CHARS && included.length > 1) {
    included = included.slice(0, Math.max(1, included.length - 10));
    prompt = renderEdgePrompt(included);
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error('model_prompt_too_large');
  }
  return { prompt, included };
}

// ---------------------------------------------------------------------------
// 模型建议解析
// ---------------------------------------------------------------------------

function modelSuggestionItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.suggestions)) return record.suggestions;
  }
  return [];
}

function parseModelSuggestions(
  answer: string,
  edges: readonly NormalizedEdge[],
): EdgeTagSuggestion[] {
  const payload = extractJsonPayload(answer);
  const items = modelSuggestionItems(payload);
  if (items.length === 0) return [];
  const byKey = new Map(edges.map((edge) => [edge.relationKey, edge]));
  const best = new Map<string, EdgeTagSuggestion>();
  for (const item of items.slice(0, 400)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const relationKey = trimText(record.relationKey, 512);
    if (!relationKey || !byKey.has(relationKey)) continue;
    const category = normalizeCategory(record.category);
    const label = trimText(record.label, MAX_LABEL_CHARS) || category;
    const confidence = clamp01(numberValue(record.confidence, 0.5));
    const reason = trimText(record.reason, MAX_REASON_CHARS);
    const suggestion: EdgeTagSuggestion = {
      relationKey,
      label,
      category,
      confidence,
      ...(reason ? { reason } : {}),
      source: 'model',
    };
    const existing = best.get(relationKey);
    if (!existing || confidence > existing.confidence) {
      best.set(relationKey, suggestion);
    }
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// 规则兜底
// ---------------------------------------------------------------------------

interface RuleDecision {
  readonly category: EdgeTagCategory;
  readonly confidence: number;
  readonly reason: string;
}

function classifyEdgeByRule(edge: NormalizedEdge): RuleDecision {
  if (OPS_PORTS.has(edge.targetPort)) {
    return {
      category: '运维工具',
      confidence: 0.65,
      reason: `端口 ${edge.targetPort} 属于运维/监控类端口`,
    };
  }
  const targetTier = edge.targetTier.toLowerCase();
  if (targetTier === 'external' || targetTier === '未纳管') {
    return { category: '外部依赖', confidence: 0.6, reason: '目标为未纳管外部依赖' };
  }
  const evidence = `${edge.targetProduct} ${edge.sourceService} ${edge.targetHost}`.toLowerCase();
  if (DATA_PATTERN.test(evidence)) {
    return {
      category: '数据访问',
      confidence: 0.65,
      reason: '目标产品/服务命中数据库或存储特征',
    };
  }
  if (MIDDLEWARE_PATTERN.test(evidence)) {
    return {
      category: '中间件访问',
      confidence: 0.6,
      reason: '目标产品/服务命中缓存、消息队列或注册中心特征',
    };
  }
  return {
    category: '应用调用',
    confidence: 0.45,
    reason: '未命中运维端口/外部/数据/中间件特征，按应用调用归类',
  };
}

function ruleSuggestion(edge: NormalizedEdge): EdgeTagSuggestion {
  const decision = classifyEdgeByRule(edge);
  return {
    relationKey: edge.relationKey,
    label: decision.category,
    category: decision.category,
    confidence: decision.confidence,
    reason: decision.reason,
    source: 'rule',
  };
}

// ---------------------------------------------------------------------------
// 对外服务
// ---------------------------------------------------------------------------

export class TopologyEdgeClassifier {
  constructor(private readonly completion: ModelCompletionService) {}

  async suggest(
    tenantId: string,
    edges: readonly EdgeClassificationInput[],
  ): Promise<EdgeClassifierResult> {
    const selected = normalizeEdges(edges);
    if (selected.length === 0) {
      return { suggestions: [], model: MODEL_LABEL, fallback: false };
    }
    try {
      const { prompt, included } = buildEdgePrompt(selected);
      const answer = await this.completion.complete({
        tenantId,
        system: EDGE_TAG_SYSTEM_PROMPT,
        prompt,
        maxTokens: 2200,
        timeoutMs: 60_000,
        json: true,
      });
      const suggestions = parseModelSuggestions(answer, included);
      if (suggestions.length === 0) {
        throw new Error('model_empty_suggestions');
      }
      return { suggestions, model: MODEL_LABEL, fallback: false };
    } catch (error) {
      const warning = describeError(error).slice(0, MAX_WARNING_CHARS);
      console.warn(`[topology] edge tag classifier failed: ${warning}`);
      return {
        suggestions: selected.map(ruleSuggestion),
        model: FALLBACK_MODEL_LABEL,
        fallback: true,
        warning,
      };
    }
  }
}
