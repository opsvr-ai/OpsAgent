/**
 * 拓扑自然语言微调器：把用户的自然语言指令转成受控的「视图/标签」操作 JSON，供前端重放。
 *
 * 安全边界：
 *   - 只允许白名单操作（hide/show node/edge、renameNode、setNodeDisplay、tagEdge、
 *     setFilter、focusNode、moveNode、resetView），绝不修改原始采集图；
 *   - nodeId / relationKey 必须来自当前图；模型只给 label/hostname 时按唯一映射解析，
 *     多个同名节点无法确定时丢弃该操作并返回 clarification；
 *   - prompt 只含节点/边目录摘要（id/label/hostname/tier/kind/appSystemName/product、
 *     relationKey/sourceLabel/targetLabel/port），不含命令/密钥等敏感数据；
 *   - 模型不可用 / JSON 非法 / 空 operations 时走确定性中文规则兜底，fallback=true、
 *     model='heuristic'、warning='rule_fallback: ...'。
 */
import type {
  TopologyAdjustOperation,
  TopologyAdjustmentResponse,
  TopologyEdge,
  TopologyGraph,
  TopologyNode,
  TopologyNodeKind,
  TopologyTier,
} from '@opsagent/contracts';
import type { ModelCompletionService } from '../models/completion.js';

export interface TopologyAdjustInput {
  readonly graph: TopologyGraph;
  readonly instruction: string;
}

export interface TopologyAdjusterResult extends TopologyAdjustmentResponse {}

const MODEL_LABEL = 'llm';
const FALLBACK_MODEL_LABEL = 'heuristic';
const MAX_OPERATIONS = 20;
const MAX_PROMPT_NODES = 60;
const MAX_PROMPT_EDGES = 100;
const MAX_INSTRUCTION_CHARS = 500;
const MAX_REPLY_CHARS = 500;
const MAX_LABEL_CHARS = 40;
const MAX_WARNING_CHARS = 200;

const TIER_VALUES: readonly TopologyTier[] = ['access', 'app', 'middleware', 'data', 'ops', 'external'];
const KIND_VALUES: readonly TopologyNodeKind[] = [
  'gateway',
  'service',
  'database',
  'cache',
  'mq',
  'registry',
  'storage',
  'monitoring',
  'logging',
  'external',
  'unknown',
];
const FILTER_KEYS = ['external', 'management', 'lowTraffic', 'unassigned'] as const;
const MOVE_DIRECTIONS = ['left', 'right', 'top', 'bottom'] as const;

const SUPPORTED_HINT =
  '可尝试：隐藏外部依赖 / 只看 app-01 / 隐藏 db-01 / 把 web-01 改名为 接入网关 / 把 db-01 标成数据层 / 隐藏 app-01→db-01:3306 / 给 app-01→db-01 打标签 数据库访问 / 重置视图。';

const ADJUST_SYSTEM_PROMPT = [
  '你是 OpsAgent 的拓扑视图微调助手。根据用户自然语言指令，生成「只影响视图/标签」的调整操作 JSON。',
  '',
  '只输出严格 JSON 对象，不要 Markdown 围栏或解释：',
  '{"reply":"给用户的简短回复（中文，≤120 字）","operations":[...],"clarification":"可选：无法确定时的追问"}',
  '',
  'operations 白名单（op 字段）：',
  '1. {"op":"hideNode","nodeId":"..."} / {"op":"showNode","nodeId":"..."}',
  '2. {"op":"hideEdge","relationKey":"..."} / {"op":"showEdge","relationKey":"..."}',
  '3. {"op":"renameNode","nodeId":"...","label":"新名称（≤40 字）"}',
  '4. {"op":"setNodeDisplay","nodeId":"...","tier?":"access|app|middleware|data|ops|external","kind?":"gateway|service|database|cache|mq|registry|storage|monitoring|logging|external|unknown","product?":"...","role?":"..."}',
  '5. {"op":"tagEdge","relationKey":"...","label":"标签（≤40 字）","category?":"...","color?":"..."}',
  '6. {"op":"setFilter","key":"external|management|lowTraffic|unassigned","value":true|false}',
  '7. {"op":"focusNode","nodeId":"..."}',
  '8. {"op":"moveNode","nodeId":"...","direction":"left|right|top|bottom","distance?":1-200}',
  '9. {"op":"resetView"}',
  '',
  '规则：',
  '- nodeId 只能使用输入 nodes[].id；relationKey 只能使用输入 edges[].relationKey；禁止编造节点或关系。',
  '- 如果用户用节点名称/主机名（label/hostname）指代节点，请先按目录唯一映射成 id；多个同名节点无法确定时不要生成该操作，在 clarification 里追问。',
  '- 只调整视图/标签（隐藏、显示、聚焦、重命名、展示分层/类型、关系标签、过滤、位置微调、重置），绝不编造节点或改变采集数据。',
  '- 支持中文和英文指令；最多生成 20 个操作；无需操作时 operations 返回空数组并给 clarification。',
].join('\n');

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cut(value: string, max: number): string {
  if (max <= 0) return '';
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function text(value: unknown, max: number): string {
  const trimmed = trim(value);
  return trimmed ? cut(trimmed, max) : '';
}

function defined<T>(source: Record<string, unknown>): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) output[key] = value;
  }
  return output as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTier(value: unknown): value is TopologyTier {
  return typeof value === 'string' && (TIER_VALUES as readonly string[]).includes(value);
}

function isKind(value: unknown): value is TopologyNodeKind {
  return typeof value === 'string' && (KIND_VALUES as readonly string[]).includes(value);
}

function isFilterKey(value: unknown): value is (typeof FILTER_KEYS)[number] {
  return typeof value === 'string' && (FILTER_KEYS as readonly string[]).includes(value);
}

function isMoveDirection(value: unknown): value is (typeof MOVE_DIRECTIONS)[number] {
  return typeof value === 'string' && (MOVE_DIRECTIONS as readonly string[]).includes(value);
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = Math.trunc(value);
    return parsed >= 0 ? parsed : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'unknown_error';
  if (typeof error === 'string' && error.trim()) return error;
  return 'unknown_error';
}

// ---------------------------------------------------------------------------
// 图索引：节点 id/alias、边 relationKey 与节点映射
// ---------------------------------------------------------------------------

interface EdgeView {
  readonly edge: TopologyEdge;
  readonly relationKey: string;
  readonly sourceNode: TopologyNode | null;
  readonly targetNode: TopologyNode | null;
}

interface GraphIndex {
  readonly nodes: readonly TopologyNode[];
  readonly nodeById: Map<string, TopologyNode>;
  readonly aliasToNodeIds: Map<string, string[]>;
  readonly edges: readonly EdgeView[];
  readonly edgeByRelationKey: Map<string, EdgeView>;
}

function relationKeyOf(
  edge: TopologyEdge,
  sourceNode: TopologyNode | null,
  targetNode: TopologyNode | null,
): string {
  const existing = trim(edge.relationKey);
  if (existing) return existing;
  const sourceHost = sourceNode?.hostname || sourceNode?.label || edge.source;
  const targetHost = targetNode?.hostname || targetNode?.label || edge.target;
  return cut(`${sourceHost}|${targetHost}:${edge.port}`, 300);
}

function nodeAliases(node: TopologyNode): string[] {
  const aliases = new Set<string>();
  for (const value of [node.label, node.hostname, node.product]) {
    const alias = trim(value).toLowerCase();
    if (alias) aliases.add(alias);
  }
  return [...aliases];
}

function buildGraphIndex(graph: TopologyGraph): GraphIndex {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const nodeById = new Map<string, TopologyNode>();
  const aliasToNodeIds = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node?.id || nodeById.has(node.id)) continue;
    nodeById.set(node.id, node);
    for (const alias of nodeAliases(node)) {
      const ids = aliasToNodeIds.get(alias) ?? [];
      if (!ids.includes(node.id)) ids.push(node.id);
      aliasToNodeIds.set(alias, ids);
    }
  }
  const edges: EdgeView[] = [];
  const edgeByRelationKey = new Map<string, EdgeView>();
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!edge?.source || !edge?.target) continue;
    const sourceNode = nodeById.get(edge.source) ?? null;
    const targetNode = nodeById.get(edge.target) ?? null;
    const relationKey = relationKeyOf(edge, sourceNode, targetNode);
    if (edgeByRelationKey.has(relationKey)) continue;
    const view: EdgeView = { edge, relationKey, sourceNode, targetNode };
    edges.push(view);
    edgeByRelationKey.set(relationKey, view);
  }
  return { nodes, nodeById, aliasToNodeIds, edges, edgeByRelationKey };
}

interface NodeResolution {
  readonly id?: string;
  readonly ambiguity?: string;
  readonly unknown?: boolean;
}

function resolveNodeId(raw: unknown, index: GraphIndex): NodeResolution {
  const value = trim(raw);
  if (!value) return { unknown: true };
  const direct = index.nodeById.get(value);
  if (direct) return { id: direct.id };
  const lower = value.toLowerCase();
  const byIdCase = [...index.nodeById.keys()].find((id) => id.toLowerCase() === lower);
  if (byIdCase) return { id: byIdCase };
  const ids = [...new Set(index.aliasToNodeIds.get(lower) ?? [])];
  if (ids.length === 0) return { unknown: true };
  const onlyId = ids[0];
  if (ids.length === 1 && onlyId) return { id: onlyId };
  return {
    ambiguity: `图里有 ${ids.length} 个节点匹配「${value}」，请用节点 id 或更精确的名称指定。`,
  };
}

function resolveEdgeKey(raw: unknown, index: GraphIndex): string | null {
  const value = trim(raw);
  if (!value) return null;
  const direct = index.edgeByRelationKey.get(value);
  if (direct) return direct.relationKey;
  const lower = value.toLowerCase();
  for (const key of index.edgeByRelationKey.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  // 兼容 "A -> B:3306" / "A→B:3306" 被模型改写的写法。
  const normalized = value.replace(/\s*(?:→|->|=>)\s*/g, '|').replace(/\s+/g, '');
  const normalizedMatch = index.edgeByRelationKey.get(normalized);
  if (normalizedMatch) return normalizedMatch.relationKey;
  return null;
}

const DISPLAY_TIER_WORDS: ReadonlyArray<{ pattern: RegExp; tier: TopologyTier }> = [
  { pattern: /接入层?|接入网?关|网关层?/, tier: 'access' },
  { pattern: /应用层?|业务层?/, tier: 'app' },
  { pattern: /中间件层?/, tier: 'middleware' },
  { pattern: /数据层?|存储层?/, tier: 'data' },
  { pattern: /运维层?|观测层?|监控层?/, tier: 'ops' },
  { pattern: /外部层?|外部依赖/, tier: 'external' },
];

const DISPLAY_KIND_WORDS: ReadonlyArray<{ pattern: RegExp; kind: TopologyNodeKind; tier?: TopologyTier }> = [
  { pattern: /数据库|关系型数据库|db$/, kind: 'database', tier: 'data' },
  { pattern: /缓存|cache|redis/, kind: 'cache', tier: 'middleware' },
  { pattern: /消息队列|消息中间件|mq$/, kind: 'mq', tier: 'middleware' },
  { pattern: /注册中心|registry/, kind: 'registry', tier: 'middleware' },
  { pattern: /对象存储|存储|storage/, kind: 'storage', tier: 'data' },
  { pattern: /接入网关|网关|gateway/, kind: 'gateway', tier: 'access' },
  { pattern: /监控|monitoring/, kind: 'monitoring', tier: 'ops' },
  { pattern: /日志|logging/, kind: 'logging', tier: 'ops' },
  { pattern: /外部依赖|外部服务|external/, kind: 'external', tier: 'external' },
];

function displayTargetOf(raw: string): { tier?: TopologyTier; kind?: TopologyNodeKind } | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  for (const item of DISPLAY_KIND_WORDS) {
    if (item.pattern.test(value)) {
      return defined<{ tier?: TopologyTier; kind?: TopologyNodeKind }>({
        tier: item.tier,
        kind: item.kind,
      });
    }
  }
  for (const item of DISPLAY_TIER_WORDS) {
    if (item.pattern.test(value)) return { tier: item.tier };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

interface PromptNode {
  readonly id: string;
  readonly label: string;
  readonly hostname?: string;
  readonly tier: TopologyTier;
  readonly kind: TopologyNodeKind;
  readonly appSystemName?: string;
  readonly product?: string;
}

interface PromptEdge {
  readonly relationKey: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly port: number;
}

function buildPrompt(index: GraphIndex, instruction: string): string {
  const nodes: PromptNode[] = index.nodes.slice(0, MAX_PROMPT_NODES).map((node) =>
    defined<PromptNode>({
      id: node.id,
      label: node.label,
      hostname: trim(node.hostname) || undefined,
      tier: node.tier,
      kind: node.kind,
      appSystemName: trim(node.appSystemName) || undefined,
      product: trim(node.product) || undefined,
    }),
  );
  const edges: PromptEdge[] = index.edges.slice(0, MAX_PROMPT_EDGES).map((view) => ({
    relationKey: view.relationKey,
    sourceLabel: view.sourceNode?.label || view.edge.source,
    targetLabel: view.targetNode?.label || view.edge.target,
    port: view.edge.port,
  }));
  return [
    '拓扑目录（节点最多 60 个、边最多 100 条；nodeId/relationKey 必须来自这里）：',
    JSON.stringify({ nodes, edges }),
    '',
    `用户指令：${cut(instruction, MAX_INSTRUCTION_CHARS)}`,
    '',
    '请只输出 JSON 对象（reply / operations / clarification?），不要 Markdown 或解释。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 模型输出解析与操作校验
// ---------------------------------------------------------------------------

interface ParsedAdjustment {
  readonly reply: string;
  readonly operations: TopologyAdjustOperation[];
  readonly clarification?: string;
}

function extractJsonObject(answer: string): Record<string, unknown> {
  const trimmed = answer.trim();
  if (!trimmed) throw new Error('model_empty_response');
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const record = asRecord(parsed);
      if (record) return record;
    } catch {
      // 尝试下一个候选片段。
    }
  }
  throw new Error('model_json_invalid');
}

interface OperationValidation {
  readonly operation?: TopologyAdjustOperation;
  readonly ambiguity?: string;
}

function ambiguityResult(ambiguity: string | undefined): OperationValidation {
  return defined<OperationValidation>({ ambiguity });
}

function validateOperation(raw: unknown, index: GraphIndex): OperationValidation {
  const record = asRecord(raw);
  if (!record) return {};
  const op = text(record.op, 40);
  switch (op) {
    case 'hideNode':
    case 'showNode':
    case 'focusNode': {
      const resolved = resolveNodeId(record.nodeId, index);
      if (!resolved.id) return ambiguityResult(resolved.ambiguity);
      return { operation: { op, nodeId: resolved.id } };
    }
    case 'hideEdge':
    case 'showEdge': {
      const relationKey = resolveEdgeKey(record.relationKey, index);
      if (!relationKey) return {};
      return { operation: { op, relationKey } };
    }
    case 'renameNode': {
      const resolved = resolveNodeId(record.nodeId, index);
      if (!resolved.id) return ambiguityResult(resolved.ambiguity);
      const label = text(record.label, MAX_LABEL_CHARS);
      if (!label) return {};
      return { operation: { op: 'renameNode', nodeId: resolved.id, label } };
    }
    case 'setNodeDisplay': {
      const resolved = resolveNodeId(record.nodeId, index);
      if (!resolved.id) return ambiguityResult(resolved.ambiguity);
      const display = defined<{
        tier?: TopologyTier;
        kind?: TopologyNodeKind;
        product?: string;
        role?: string;
      }>({
        tier: isTier(record.tier) ? record.tier : undefined,
        kind: isKind(record.kind) ? record.kind : undefined,
        product: text(record.product, 40) || undefined,
        role: text(record.role, 60) || undefined,
      });
      if (!display.tier && !display.kind && !display.product && !display.role) return {};
      return {
        operation: defined<TopologyAdjustOperation>({
          op: 'setNodeDisplay',
          nodeId: resolved.id,
          ...display,
        }),
      };
    }
    case 'tagEdge': {
      const relationKey = resolveEdgeKey(record.relationKey, index);
      if (!relationKey) return {};
      const label = text(record.label, MAX_LABEL_CHARS);
      if (!label) return {};
      const category = text(record.category, 40);
      const color = text(record.color, 20);
      return {
        operation: defined<TopologyAdjustOperation>({
          op: 'tagEdge',
          relationKey,
          label,
          category: category || undefined,
          color: color || undefined,
        }),
      };
    }
    case 'setFilter': {
      if (!isFilterKey(record.key) || typeof record.value !== 'boolean') return {};
      return { operation: { op: 'setFilter', key: record.key, value: record.value } };
    }
    case 'moveNode': {
      const resolved = resolveNodeId(record.nodeId, index);
      if (!resolved.id) return ambiguityResult(resolved.ambiguity);
      if (!isMoveDirection(record.direction)) return {};
      const distance = nonNegativeInt(record.distance);
      return {
        operation: defined<TopologyAdjustOperation>({
          op: 'moveNode',
          nodeId: resolved.id,
          direction: record.direction,
          distance: distance !== null && distance > 0 ? Math.min(distance, 200) : undefined,
        }),
      };
    }
    case 'resetView':
      return { operation: { op: 'resetView' } };
    default:
      return {};
  }
}

function defaultReply(operations: readonly TopologyAdjustOperation[], clarification?: string): string {
  if (clarification) return clarification;
  if (operations.length === 0) return '没有生成可执行的视图调整操作。';
  return `已生成 ${operations.length} 个视图调整操作。`;
}

function parseModelAdjustment(answer: string, index: GraphIndex): ParsedAdjustment {
  const root = extractJsonObject(answer);
  const reply = text(root.reply, MAX_REPLY_CHARS);
  const modelClarification = text(root.clarification, 300);
  const rawOperations = Array.isArray(root.operations) ? root.operations : [];
  const operations: TopologyAdjustOperation[] = [];
  let ambiguity: string | undefined;
  for (const raw of rawOperations.slice(0, 200)) {
    if (operations.length >= MAX_OPERATIONS) break;
    const validated = validateOperation(raw, index);
    if (validated.operation) operations.push(validated.operation);
    if (!ambiguity && validated.ambiguity) ambiguity = validated.ambiguity;
  }
  return defined<ParsedAdjustment>({
    reply,
    operations,
    clarification: modelClarification || ambiguity || undefined,
  });
}

// ---------------------------------------------------------------------------
// 规则兜底：常见中文指令
// ---------------------------------------------------------------------------

interface RuleAdjustment {
  readonly reply: string;
  readonly operations: TopologyAdjustOperation[];
  readonly clarification?: string;
}

function pushOperation(
  operations: TopologyAdjustOperation[],
  operation: TopologyAdjustOperation,
): void {
  if (operations.length < MAX_OPERATIONS) operations.push(operation);
}

function findNodeInText(index: GraphIndex, value: string): NodeResolution {
  const lower = value.toLowerCase();
  const matches = [...index.aliasToNodeIds.entries()]
    .filter(([alias]) => alias.length > 0 && lower.includes(alias))
    .map(([alias, ids]) => ({ alias, ids: [...new Set(ids)] }))
    .sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  if (matches.length === 0) return { unknown: true };
  const best = matches[0];
  if (!best) return { unknown: true };
  if (best.ids.length === 1) {
    const id = best.ids[0];
    return id ? { id } : { unknown: true };
  }
  return {
    ambiguity: `图里有 ${best.ids.length} 个节点匹配「${best.alias}」，请用节点 id 或更精确的名称指定。`,
  };
}

function cleanToken(value: string): string {
  return value.trim().replace(/^["'「『]|["'」』]$/g, '').trim();
}

function resolveNodeToken(index: GraphIndex, token: string): NodeResolution {
  const cleaned = cleanToken(token).replace(/[:：]\d+$/, '').trim();
  return resolveNodeId(cleaned, index);
}

function findEdgeKey(
  index: GraphIndex,
  sourceToken: string,
  targetToken: string,
  port: number | null,
): { relationKey?: string; ambiguity?: string } {
  const source = resolveNodeToken(index, sourceToken);
  const target = resolveNodeToken(index, targetToken);
  if (source.ambiguity) return { ambiguity: source.ambiguity };
  if (target.ambiguity) return { ambiguity: target.ambiguity };
  if (!source.id || !target.id) return {};
  const matches = index.edges.filter((view) => {
    if (port !== null && view.edge.port !== port) return false;
    const forward = view.edge.source === source.id && view.edge.target === target.id;
    const reverse = view.edge.source === target.id && view.edge.target === source.id;
    return forward || reverse;
  });
  if (matches.length === 1) {
    const relationKey = matches[0]?.relationKey;
    return relationKey ? { relationKey } : {};
  }
  if (matches.length > 1) {
    return {
      ambiguity: `找到 ${matches.length} 条「${sourceToken} → ${targetToken}」的关系，请指定端口或 relationKey。`,
    };
  }
  return {};
}

function ruleAdjust(index: GraphIndex, instruction: string): RuleAdjustment {
  const text = instruction.trim();
  const operations: TopologyAdjustOperation[] = [];
  let clarification: string | undefined;
  const finish = (): RuleAdjustment =>
    defined<RuleAdjustment>({
      reply:
        operations.length > 0
          ? `已按规则生成 ${operations.length} 个视图调整操作。`
          : '没有识别出可执行的调整操作。',
      operations,
      clarification,
    });

  if (!text) {
    return {
      reply: '指令为空，请描述想要的视图调整。',
      operations: [],
      clarification: '指令为空，请描述要调整的内容。',
    };
  }

  // 1) 重置视图。
  if (/(重置|恢复默认|恢复视图|还原视图|重置视图)/.test(text)) {
    pushOperation(operations, { op: 'resetView' });
    return finish();
  }

  // 2) 外部依赖过滤。
  const hideExternal = /(隐藏|收起|关闭|不显示|过滤掉|去掉).*(外部|未纳管)/.test(text);
  const showExternal = /(显示|展开|恢复).*(外部|未纳管)/.test(text);
  if (hideExternal || showExternal) {
    pushOperation(operations, { op: 'setFilter', key: 'external', value: hideExternal });
    return finish();
  }

  // 3) 只看/聚焦/定位某节点。
  const focusMatch = /(?:只看|聚焦到?|定位到?|聚焦在)\s*(.+)$/.exec(text);
  if (focusMatch?.[1]) {
    const resolved = findNodeInText(index, focusMatch[1]);
    if (resolved.id) {
      pushOperation(operations, { op: 'focusNode', nodeId: resolved.id });
    } else if (resolved.ambiguity) {
      clarification = resolved.ambiguity;
    }
    return finish();
  }

  // 4) 改名（显式动词）与展示分层/类型。
  const renameMatch = /(?:把|将)?\s*(.+?)\s*(?:改名为|重命名为|命名为|改叫|叫做|叫)\s*(.+)$/.exec(text);
  if (renameMatch?.[1] && renameMatch[2]) {
    const subject = cleanToken(renameMatch[1]);
    const label = cut(cleanToken(renameMatch[2]), MAX_LABEL_CHARS);
    const resolved = resolveNodeToken(index, subject);
    if (resolved.ambiguity) clarification = resolved.ambiguity;
    if (resolved.id && label) {
      pushOperation(operations, { op: 'renameNode', nodeId: resolved.id, label });
    }
    return finish();
  }

  const displayMatch = /(?:把|将)?\s*(.+?)\s*(?:标成|标为|改成|设为|归类为|归为|归到)\s*(.+)$/.exec(text);
  if (displayMatch?.[1] && displayMatch[2]) {
    const subject = cleanToken(displayMatch[1]);
    const target = cleanToken(displayMatch[2]);
    const resolved = resolveNodeToken(index, subject);
    if (resolved.ambiguity) clarification = resolved.ambiguity;
    if (resolved.id) {
      const display = displayTargetOf(target);
      if (display) {
        pushOperation(
          operations,
          defined<TopologyAdjustOperation>({
            op: 'setNodeDisplay',
            nodeId: resolved.id,
            ...display,
          }),
        );
      } else if (target) {
        pushOperation(operations, {
          op: 'renameNode',
          nodeId: resolved.id,
          label: cut(target, MAX_LABEL_CHARS),
        });
      }
    }
    return finish();
  }

  // 5) 关系标签（A→B 打标签 X）。
  const tagMatch = /(?:给|对|把)?\s*(.+?)\s*(?:→|->)\s*(.+?)\s*(?:打|添加|加|设置|标记)?\s*标签\s*[:：]?\s*(.+)$/.exec(text);
  if (tagMatch?.[1] && tagMatch[2] && tagMatch[3]) {
    const targetToken = cleanToken(tagMatch[2]);
    const portMatch = /:(\d+)$/.exec(targetToken);
    const port = portMatch?.[1] ? Number.parseInt(portMatch[1], 10) : null;
    const targetClean = targetToken.replace(/[:：]\d+$/, '');
    const found = findEdgeKey(index, cleanToken(tagMatch[1]), targetClean, port);
    if (found.ambiguity) clarification = found.ambiguity;
    if (found.relationKey) {
      const label = cut(cleanToken(tagMatch[3]), MAX_LABEL_CHARS);
      if (label) pushOperation(operations, { op: 'tagEdge', relationKey: found.relationKey, label });
    }
    return finish();
  }

  // 6) 隐藏/显示关系（A→B[:port]）。
  const edgeMatch = /(隐藏|收起|关闭|不显示|去掉|显示|展开)\s*(?:关系|访问|链路)?\s*(.+?)\s*(?:→|->)\s*(.+)$/.exec(text);
  if (edgeMatch?.[1] && edgeMatch[2] && edgeMatch[3]) {
    const targetToken = cleanToken(edgeMatch[3]);
    const portMatch = /:(\d+)$/.exec(targetToken);
    const port = portMatch?.[1] ? Number.parseInt(portMatch[1], 10) : null;
    const found = findEdgeKey(
      index,
      cleanToken(edgeMatch[2]),
      targetToken.replace(/[:：]\d+$/, ''),
      port,
    );
    if (found.ambiguity) clarification = found.ambiguity;
    if (found.relationKey) {
      pushOperation(operations, {
        op: /显示|展开/.test(edgeMatch[1]) ? 'showEdge' : 'hideEdge',
        relationKey: found.relationKey,
      });
    }
    return finish();
  }

  // 7) 隐藏/显示节点（按 label/hostname/product 唯一匹配）。
  const hideMatch = /(隐藏|收起|关闭|不显示|去掉)/.test(text);
  const showMatch = /(显示|展开|恢复显示)/.test(text);
  if ((hideMatch || showMatch) && !/(关系|链路)/.test(text)) {
    const resolved = findNodeInText(index, text);
    if (resolved.id) {
      pushOperation(operations, {
        op: hideMatch ? 'hideNode' : 'showNode',
        nodeId: resolved.id,
      });
    } else if (resolved.ambiguity) {
      clarification = resolved.ambiguity;
    }
    return finish();
  }

  // 8) 其他过滤器。
  const filterKey: 'management' | 'lowTraffic' | 'unassigned' | null = /管理|纳管/.test(text)
    ? 'management'
    : /低流量|流量低/.test(text)
      ? 'lowTraffic'
      : /未归属|未分配/.test(text)
        ? 'unassigned'
        : null;
  if (filterKey && (hideMatch || showMatch)) {
    pushOperation(operations, { op: 'setFilter', key: filterKey, value: hideMatch });
    return finish();
  }

  clarification = `无法识别该指令。${SUPPORTED_HINT}`;
  return {
    reply: '没有识别出可执行的视图调整操作。',
    operations,
    clarification,
  };
}

// ---------------------------------------------------------------------------
// 对外服务
// ---------------------------------------------------------------------------

export class TopologyAdjuster {
  constructor(private readonly completion: ModelCompletionService) {}

  async adjust(
    tenantId: string,
    input: TopologyAdjustInput,
  ): Promise<TopologyAdjustmentResponse> {
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
    const index = buildGraphIndex(input.graph);

    if (!instruction) {
      const ruled = ruleAdjust(index, instruction);
      return {
        reply: ruled.reply,
        operations: ruled.operations,
        model: FALLBACK_MODEL_LABEL,
        fallback: true,
        warning: 'rule_fallback: empty_instruction',
        ...(ruled.clarification ? { clarification: ruled.clarification } : {}),
      };
    }

    try {
      const system = ADJUST_SYSTEM_PROMPT;
      const prompt = buildPrompt(index, instruction);
      const answer = await this.completion.complete({
        tenantId,
        system,
        prompt,
        maxTokens: 1200,
        timeoutMs: 60_000,
        json: true,
      });
      const parsed = parseModelAdjustment(answer, index);
      if (parsed.operations.length === 0 && !parsed.clarification) {
        throw new Error('model_empty_operations');
      }
      return {
        reply: parsed.reply || defaultReply(parsed.operations, parsed.clarification),
        operations: parsed.operations,
        model: MODEL_LABEL,
        fallback: false,
        ...(parsed.clarification ? { clarification: parsed.clarification } : {}),
      };
    } catch (error) {
      const reason = cut(describeError(error), MAX_WARNING_CHARS);
      const ruled = ruleAdjust(index, instruction);
      return {
        reply: ruled.reply,
        operations: ruled.operations,
        model: FALLBACK_MODEL_LABEL,
        fallback: true,
        warning: cut(`rule_fallback: ${reason}`, MAX_WARNING_CHARS),
        ...(ruled.clarification ? { clarification: ruled.clarification } : {}),
      };
    }
  }
}
