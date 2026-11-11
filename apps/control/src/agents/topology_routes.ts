import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type {
  EdgeTagSuggestion,
  EdgeTagSuggestResponse,
  TopologyAdjustmentResponse,
  TopologyEdgeTag,
  TopologyGraph,
  TopologyScope,
} from '@opsagent/contracts';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext } from '../tenancy/context.js';
import type { TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { ModelCompletionService } from '../models/completion.js';
import { ModelProviderService } from '../models/service.js';
import { AgentConnectionEdgeService } from './connection_edges.js';
import { TopologyAdjuster } from './topology_adjuster.js';
import { TopologyAdjustmentService } from './topology_adjustments.js';
import {
  TopologyLearningError,
  TopologyLearningService,
} from './topology_learning.js';
import {
  TopologyEdgeTagService,
  normalizeEdgeTagInput,
  topologyNodeRelationName,
  topologyRelationKey,
} from './topology_tags.js';
import { AccessTrendError, AccessTrendService } from './topology_trends.js';
import { HttpRequestTrendError, HttpRequestTrendService } from './topology_http_requests.js';

/**
 * 访问拓扑学习 API（/api/topologies 前缀）。
 *
 * 认证方式与 agents/routes.ts 一致：cookie session + 租户上下文 + agent.manage 权限。
 * 路由注册顺序：/latest、/learn*、/policy 必须在 /:id 之前。
 */

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  pool: Pool,
): Promise<TenantContext | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  const session = await readSession(pool, token);
  if (!session?.selectedTenantId) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  const ctx = await resolveTenantContext(
    { userId: session.user.id, tenantId: session.selectedTenantId },
    createMembershipRepository(pool),
  );
  try {
    requirePermission(ctx, 'agent.manage');
  } catch (error) {
    if (error instanceof ForbiddenError) {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    throw error;
  }
  return ctx;
}

/** 会话/策略业务错误 → 规范错误码。 */
function sendLearningError(reply: FastifyReply, error: unknown): void {
  if (error instanceof TopologyLearningError) {
    if (error.code === 'app_system_not_found' || error.code === 'session_not_found') {
      reply.code(404).send({ error: error.code });
      return;
    }
    if (error.code === 'session_not_cancellable'
      || error.code === 'session_not_ready'
      || error.code === 'session_collecting'
      || error.code === 'session_cancelled'
      || error.code === 'session_not_analyzable'
      || error.code === 'no_managed_hosts') {
      reply.code(409).send({ error: error.code });
      return;
    }
    reply.code(400).send({ error: error.code });
    return;
  }
  throw error;
}

function parseAppSystemId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isUuid(value.trim())) return undefined;
  return value.trim();
}

function parseScope(value: unknown): TopologyScope | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind === 'tenant') return { kind: 'tenant', appSystemId: null };
  if (value.kind === 'app-system') {
    const appSystemId = typeof value.appSystemId === 'string' && isUuid(value.appSystemId)
      ? value.appSystemId
      : null;
    if (!appSystemId) return undefined;
    return { kind: 'app-system', appSystemId };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// AI 标签建议：EdgeClassificationInput → TopologyEdgeClassifier → 兜底规则
// ---------------------------------------------------------------------------

/** 与 topology-llm 的 topology_edge_classifier.ts 保持结构一致（该文件由其维护）。 */
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

export interface EdgeClassifierResultLike {
  readonly suggestions: readonly EdgeTagSuggestion[];
  readonly model: string;
  readonly fallback: boolean;
  readonly warning?: string;
}

export interface EdgeClassifierLike {
  suggest(tenantId: string, edges: readonly EdgeClassificationInput[]): Promise<EdgeClassifierResultLike>;
}

const OPS_TAG_PORTS = new Set([22, 3000, 9090, 9100, 10050, 10051]);
const OPS_TAG_PATTERN = /(opsagent|sshd|zabbix|node_exporter|prometheus|grafana)/i;
const DATA_TAG_PATTERN = /(mysql|mariadb|postgres|postgresql|oracle|mongo|clickhouse|elasticsearch)/i;
const DATA_TAG_ES_PATTERN = /(^|[-_])es($|[-_])/i;
const MIDDLEWARE_TAG_PATTERN = /(redis|kafka|rabbitmq|nacos|zookeeper)/i;

function fallbackTagCategory(edge: EdgeClassificationInput): string {
  const service = edge.sourceService ?? '';
  if (OPS_TAG_PORTS.has(edge.targetPort) || OPS_TAG_PATTERN.test(service)) return '运维工具';
  if (edge.targetTier === 'external') return '外部依赖';
  const product = edge.targetProduct ?? '';
  if (edge.targetTier === 'data' || DATA_TAG_PATTERN.test(product) || DATA_TAG_ES_PATTERN.test(product)) {
    return '数据访问';
  }
  if (edge.targetTier === 'middleware' || MIDDLEWARE_TAG_PATTERN.test(product)) return '中间件访问';
  return '应用调用';
}

/** 确定性规则兜底建议（分类器不可用/输出为空时使用）。 */
export function buildRuleSuggestions(
  edges: readonly EdgeClassificationInput[],
  warning?: string,
): EdgeTagSuggestResponse {
  const suggestions: EdgeTagSuggestion[] = edges.map((edge) => {
    const category = fallbackTagCategory(edge);
    return {
      relationKey: edge.relationKey,
      label: category,
      category,
      confidence: 0.55,
      reason: `规则兜底：按端口 ${edge.targetPort} / 目标层级 ${edge.targetTier ?? 'unknown'} 判定为${category}`,
      source: 'rule',
    };
  });
  return {
    suggestions,
    model: 'rule',
    fallback: true,
    ...(warning ? { warning: warning.slice(0, 500) } : {}),
  };
}

function edgeSourceName(graph: TopologyGraph, id: string): string {
  const node = graph.nodes.find((item) => item.id === id);
  return node ? topologyNodeRelationName(node) : id;
}

function edgeTargetNode(graph: TopologyGraph, id: string) {
  return graph.nodes.find((item) => item.id === id);
}

/** 从最新拓扑图取前 80 条边，构造分类器输入（relationKeys 传入时先过滤）。 */
export function collectEdgeClassificationInputs(
  graph: TopologyGraph,
  relationKeys?: readonly string[],
): EdgeClassificationInput[] {
  const wanted = relationKeys && relationKeys.length > 0 ? new Set(relationKeys) : null;
  const inputs: EdgeClassificationInput[] = [];
  for (const edge of graph.edges) {
    if (inputs.length >= 80) break;
    const targetNode = edgeTargetNode(graph, edge.target);
    const relationKey = edge.relationKey
      ?? topologyRelationKey(edgeSourceName(graph, edge.source), edgeTargetNode(graph, edge.target)
        ? topologyNodeRelationName(edgeTargetNode(graph, edge.target)!)
        : edge.target, edge.port);
    if (wanted && !wanted.has(relationKey)) continue;
    const sourceNode = graph.nodes.find((item) => item.id === edge.source);
    inputs.push({
      relationKey,
      sourceHost: sourceNode ? topologyNodeRelationName(sourceNode) : edge.source,
      targetHost: targetNode ? topologyNodeRelationName(targetNode) : edge.target,
      targetPort: edge.port,
      ...(edge.processes?.[0] ? { sourceService: edge.processes[0].slice(0, 120) } : {}),
      ...(targetNode?.product ? { targetProduct: targetNode.product.slice(0, 120) } : {}),
      ...(targetNode?.tier ? { targetTier: targetNode.tier } : {}),
      ...(edge.protocol ? { protocol: edge.protocol } : {}),
    });
  }
  return inputs;
}

function normalizeClassifierSuggestions(
  suggestions: readonly EdgeTagSuggestion[],
  inputs: readonly EdgeClassificationInput[],
  source: 'model' | 'rule',
): EdgeTagSuggestion[] {
  const allowed = new Map(inputs.map((input) => [input.relationKey, input]));
  const output: EdgeTagSuggestion[] = [];
  for (const suggestion of suggestions.slice(0, 80)) {
    if (!allowed.has(suggestion.relationKey)) continue;
    const label = typeof suggestion.label === 'string' ? suggestion.label.trim().slice(0, 40) : '';
    const category = typeof suggestion.category === 'string' ? suggestion.category.trim().slice(0, 40) : '';
    if (!label || !category) continue;
    const confidence = Number.isFinite(suggestion.confidence) ? Math.min(Math.max(suggestion.confidence, 0), 1) : 0.6;
    output.push({
      relationKey: suggestion.relationKey,
      label,
      category,
      confidence,
      ...(typeof suggestion.reason === 'string' && suggestion.reason.trim()
        ? { reason: suggestion.reason.trim().slice(0, 300) }
        : {}),
      source,
    });
  }
  return output;
}

/** 调用分类器；不可用/抛错/空结果时回退规则建议（fallback=true，warning 带原因）。 */
export async function suggestEdgeTagsFromGraph(args: {
  readonly tenantId: string;
  readonly edges: readonly EdgeClassificationInput[];
  readonly classifier?: EdgeClassifierLike | undefined;
}): Promise<EdgeTagSuggestResponse> {
  if (args.edges.length === 0) {
    return { suggestions: [], model: 'rule', fallback: false };
  }
  if (!args.classifier) {
    return buildRuleSuggestions(args.edges, 'classifier_unavailable: 分类器未就绪，已按规则给出建议');
  }
  try {
    const result = await args.classifier.suggest(args.tenantId, args.edges);
    const suggestions = normalizeClassifierSuggestions(
      result.suggestions ?? [],
      args.edges,
      result.fallback ? 'rule' : 'model',
    );
    if (suggestions.length === 0) {
      return buildRuleSuggestions(args.edges, 'classifier_empty: 分类器未返回有效建议，已按规则给出建议');
    }
    const warning = result.fallback
      ? `模型建议不可用（${result.warning ?? 'model_unavailable'}），已按规则给出建议`
      : result.warning;
    return {
      suggestions,
      model: (result.model || 'llm').slice(0, 120),
      fallback: result.fallback === true,
      ...(warning ? { warning: warning.slice(0, 500) } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildRuleSuggestions(args.edges, `classifier_error: ${message}`.slice(0, 500));
  }
}

/** 动态加载 LLM 分类器；topology-llm 交付前保持可控降级。 */
async function loadEdgeClassifier(completion: ModelCompletionService): Promise<EdgeClassifierLike | undefined> {
  // TODO(classifier): topology_edge_classifier.ts 交付后改为静态 import。
  const specifier = './topology_edge_classifier.js';
  try {
    const loaded = (await import(specifier)) as {
      TopologyEdgeClassifier?: new (service: ModelCompletionService) => EdgeClassifierLike;
    };
    const Classifier = loaded.TopologyEdgeClassifier;
    return typeof Classifier === 'function' ? new Classifier(completion) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 自然语言拓扑微调：TopologyAdjuster → 持久化历史
// ---------------------------------------------------------------------------

/** 与 topology-llm 的 topology_adjuster.ts 保持结构一致。 */
export interface TopologyAdjusterLike {
  adjust(
    tenantId: string,
    input: { readonly graph: TopologyGraph; readonly instruction: string },
  ): Promise<TopologyAdjustmentResponse>;
}

let adjusterForTests: TopologyAdjusterLike | null | undefined;

/** 测试注入：不传参数恢复为动态加载，传 null 模拟"微调器不可用"。 */
export function setTopologyAdjusterForTests(adjuster?: TopologyAdjusterLike | null): void {
  adjusterForTests = adjuster;
}

/** 自然语言微调器（topology-llm 提供，接口稳定）。 */
function loadTopologyAdjuster(completion: ModelCompletionService): TopologyAdjusterLike {
  return new TopologyAdjuster(completion);
}

function fallbackAdjustmentResponse(warning: string): TopologyAdjustmentResponse {
  return {
    reply: '暂时无法调用 AI 微调器，已保留原图。请稍后重试，或用更明确的指令。',
    operations: [],
    model: 'rule',
    fallback: true,
    warning: warning.slice(0, 500),
  };
}

export function registerTopologyRoutes(
  app: FastifyInstance,
  pool: Pool,
  service?: TopologyLearningService,
  modelSecret?: string,
  edgeClassifier?: EdgeClassifierLike,
): void {
  const learning = service ?? new TopologyLearningService(pool, modelSecret);
  const edgeSamples = new AgentConnectionEdgeService(pool);
  const edgeTags = new TopologyEdgeTagService(pool);
  const trends = new AccessTrendService(pool, edgeTags);
  const httpTrends = new HttpRequestTrendService(pool, edgeTags);
  const adjustments = new TopologyAdjustmentService(pool);
  const completion = new ModelCompletionService(
    new ModelProviderService(pool, modelSecret ?? process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret'),
  );

  app.post('/api/topologies/learn', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    const body = request.body as {
      appSystemId?: unknown;
      windowSeconds?: unknown;
      includeUnassigned?: unknown;
    } | undefined;
    const appSystemId = parseAppSystemId(body?.appSystemId);
    if (appSystemId === undefined) return reply.code(400).send({ error: 'invalid_app_system' });
    if (body?.windowSeconds !== undefined
      && (typeof body.windowSeconds !== 'number' || !Number.isInteger(body.windowSeconds))) {
      return reply.code(400).send({ error: 'invalid_window' });
    }
    if (body?.includeUnassigned !== undefined && typeof body.includeUnassigned !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      const session = await learning.start(
        ctx.tenantId,
        {
          appSystemId,
          ...(typeof body?.windowSeconds === 'number' ? { windowSeconds: body.windowSeconds } : {}),
          ...(typeof body?.includeUnassigned === 'boolean' ? { includeUnassigned: body.includeUnassigned } : {}),
        },
        { requestedBy: ctx.userId, trigger: 'manual' },
      );
      return reply.code(201).send(session);
    } catch (error) {
      sendLearningError(reply, error);
    }
  });

  app.get<{ Querystring: { appSystemId?: string } }>('/api/topologies/learn/active', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    const appSystemId = parseAppSystemId(request.query.appSystemId);
    if (appSystemId === undefined) return reply.code(400).send({ error: 'invalid_app_system' });
    return reply.send(await learning.active(ctx.tenantId, appSystemId));
  });

  app.get<{ Params: { id: string } }>('/api/topologies/learn/:id', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'session_not_found' });
    const session = await learning.progress(ctx.tenantId, request.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    return reply.send(session);
  });

  app.post<{ Params: { id: string } }>('/api/topologies/learn/:id/analyze', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'session_not_found' });
    try {
      const session = await learning.analyzeAgain(ctx.tenantId, request.params.id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      return reply.send(session);
    } catch (error) {
      sendLearningError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/topologies/learn/:id/cancel', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'session_not_found' });
    try {
      const session = await learning.cancel(ctx.tenantId, request.params.id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      return reply.send(session);
    } catch (error) {
      sendLearningError(reply, error);
    }
  });

  // 演示/测试入口：把 Agent 上报格式的窗口样本直接写入边样本表。
  app.post<{ Params: { id: string } }>('/api/topologies/learn/:id/samples', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'session_not_found' });
    const session = await learning.getSession(ctx.tenantId, request.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const body = request.body as { agentId?: unknown; windows?: unknown } | undefined;
    const agentId = typeof body?.agentId === 'string' && isUuid(body.agentId) ? body.agentId : null;
    if (!agentId) return reply.code(400).send({ error: 'invalid_agent' });
    if (!Array.isArray(body?.windows)) return reply.code(400).send({ error: 'invalid_request' });
    const agent = await pool.query(
      'SELECT 1 FROM agents WHERE tenant_id = $1 AND id = $2',
      [ctx.tenantId, agentId],
    );
    if ((agent.rowCount ?? 0) === 0) return reply.code(404).send({ error: 'agent_not_found' });
    const accepted = await edgeSamples.sync(ctx.tenantId, agentId, body.windows);
    return reply.send({ accepted });
  });

  app.get<{ Querystring: { limit?: string } }>('/api/topologies', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    const limit = Number.parseInt(request.query.limit ?? '20', 10);
    return reply.send({ graphs: await learning.list(ctx.tenantId, Number.isFinite(limit) ? limit : 20) });
  });

  app.get<{ Querystring: { appSystemId?: string } }>('/api/topologies/latest', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    const appSystemId = parseAppSystemId(request.query.appSystemId);
    if (appSystemId === undefined) return reply.code(400).send({ error: 'invalid_app_system' });
    const graph = await learning.latest(ctx.tenantId, appSystemId);
    // 无图时返回 JSON null（200），由前端渲染空态。
    return reply.send(graph);
  });

  app.get('/api/topologies/policy', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    return reply.send(await learning.getPolicy(ctx.tenantId));
  });

  app.put('/api/topologies/policy', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    const body = request.body as {
      enabled?: unknown;
      intervalSeconds?: unknown;
      windowSeconds?: unknown;
      scope?: unknown;
      includeUnassigned?: unknown;
    } | undefined;
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (body?.includeUnassigned !== undefined && typeof body.includeUnassigned !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (body?.intervalSeconds !== undefined
      && (typeof body.intervalSeconds !== 'number' || !Number.isInteger(body.intervalSeconds))) {
      return reply.code(400).send({ error: 'invalid_interval' });
    }
    if (body?.windowSeconds !== undefined
      && (typeof body.windowSeconds !== 'number' || !Number.isInteger(body.windowSeconds))) {
      return reply.code(400).send({ error: 'invalid_window' });
    }
    const scope = body?.scope === undefined ? undefined : parseScope(body.scope);
    if (body?.scope !== undefined && !scope) return reply.code(400).send({ error: 'invalid_scope' });
    try {
      const policy = await learning.updatePolicy(ctx.tenantId, {
        ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body?.intervalSeconds === 'number' ? { intervalSeconds: body.intervalSeconds } : {}),
        ...(typeof body?.windowSeconds === 'number' ? { windowSeconds: body.windowSeconds } : {}),
        ...(scope ? { scope } : {}),
        ...(typeof body?.includeUnassigned === 'boolean' ? { includeUnassigned: body.includeUnassigned } : {}),
      });
      return reply.send(policy);
    } catch (error) {
      sendLearningError(reply, error);
    }
  });

  // 访问关系标签（按 relationKey 跨版本复用）。
  app.get<{ Querystring: { relationKey?: string } }>('/api/topologies/edge-tags', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    const relationKey = typeof request.query.relationKey === 'string' && request.query.relationKey.trim()
      ? request.query.relationKey.trim()
      : undefined;
    return reply.send({ tags: await edgeTags.list(ctx.tenantId, relationKey) });
  });

  app.post('/api/topologies/edge-tags', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    const normalized = normalizeEdgeTagInput(request.body);
    if (!normalized) return reply.code(400).send({ error: 'invalid_request' });
    const tag = await edgeTags.create(ctx.tenantId, normalized, ctx.userId);
    if (!tag) return reply.code(400).send({ error: 'invalid_request' });
    return reply.code(201).send(tag);
  });

  app.delete<{ Params: { id: string } }>('/api/topologies/edge-tags/:id', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'edge_tag_not_found' });
    const deleted = await edgeTags.delete(ctx.tenantId, request.params.id);
    if (!deleted) return reply.code(404).send({ error: 'edge_tag_not_found' });
    return reply.send({ ok: true });
  });

  // 访问量趋势：out 方向建连样本按小时/天分桶，供页面表格与 sparkline 使用。
  app.get<{ Querystring: { windowHours?: string; bucket?: string; appSystemId?: string } }>(
    '/api/topologies/access-trends',
    async (request, reply) => {
      const ctx = await authorize(request, reply, pool);
      if (!ctx) return;
      const windowHours = request.query.windowHours === undefined
        ? 24
        : Number.parseInt(request.query.windowHours, 10);
      if (!Number.isFinite(windowHours)) return reply.code(400).send({ error: 'invalid_window' });
      const bucket = request.query.bucket ?? 'hour';
      if (bucket !== 'hour' && bucket !== 'day') return reply.code(400).send({ error: 'invalid_bucket' });
      const appSystemId = parseAppSystemId(request.query.appSystemId);
      if (appSystemId === undefined) return reply.code(400).send({ error: 'invalid_app_system' });
      try {
        const response = await trends.get(ctx.tenantId, { windowHours, bucket, appSystemId });
        return reply.send(response);
      } catch (error) {
        if (error instanceof AccessTrendError) {
          return reply.code(400).send({ error: error.code });
        }
        throw error;
      }
    },
  );

  // HTTP/gRPC 请求量趋势（仅明文旁路：http1/http2/grpc）。
  app.get<{ Querystring: { windowHours?: string; bucket?: string; appSystemId?: string } }>(
    '/api/topologies/http-requests',
    async (request, reply) => {
      const ctx = await authorize(request, reply, pool);
      if (!ctx) return;
      const windowHours = request.query.windowHours === undefined
        ? 24
        : Number.parseInt(request.query.windowHours, 10);
      if (!Number.isFinite(windowHours)) return reply.code(400).send({ error: 'invalid_window' });
      const bucket = request.query.bucket ?? 'hour';
      if (bucket !== 'hour' && bucket !== 'day') return reply.code(400).send({ error: 'invalid_bucket' });
      const appSystemId = parseAppSystemId(request.query.appSystemId);
      if (appSystemId === undefined) return reply.code(400).send({ error: 'invalid_app_system' });
      try {
        const response = await httpTrends.get(ctx.tenantId, { windowHours, bucket, appSystemId });
        return reply.send(response);
      } catch (error) {
        if (error instanceof HttpRequestTrendError) {
          return reply.code(400).send({ error: error.code });
        }
        throw error;
      }
    },
  );

  // AI 标签建议：调用 LLM 分类器；不可用时规则兜底并返回 warning。
  app.post('/api/topologies/edge-tags/suggest', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    const body = request.body as {
      appSystemId?: unknown;
      relationKeys?: unknown;
    } | undefined;
    const appSystemId = parseAppSystemId(body?.appSystemId);
    if (appSystemId === undefined) return reply.code(400).send({ error: 'invalid_app_system' });
    let relationKeys: string[] | undefined;
    if (body?.relationKeys !== undefined) {
      if (!Array.isArray(body.relationKeys)
        || body.relationKeys.some((item) => typeof item !== 'string')) {
        return reply.code(400).send({ error: 'invalid_relation_keys' });
      }
      relationKeys = (body.relationKeys as string[])
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 500);
    }
    const graph = await learning.latest(ctx.tenantId, appSystemId);
    if (!graph) return reply.code(404).send({ error: 'topology_not_found' });
    const inputs = collectEdgeClassificationInputs(graph, relationKeys);
    const classifier = edgeClassifier ?? await loadEdgeClassifier(completion);
    const response = await suggestEdgeTagsFromGraph({
      tenantId: ctx.tenantId,
      edges: inputs,
      ...(classifier ? { classifier } : {}),
    });
    return reply.send(response);
  });

  // 自然语言微调：调用 LLM 微调器生成视图操作并持久化历史。
  app.post<{ Params: { id: string } }>('/api/topologies/:id/adjust', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'topology_not_found' });
    const body = request.body as { instruction?: unknown } | undefined;
    const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
    if (!instruction || instruction.length > 500) {
      return reply.code(400).send({ error: 'invalid_instruction' });
    }
    const graph = await learning.get(ctx.tenantId, request.params.id);
    if (!graph) return reply.code(404).send({ error: 'topology_not_found' });
    let response: TopologyAdjustmentResponse;
    try {
      const adjuster = adjusterForTests !== undefined
        ? adjusterForTests
        : loadTopologyAdjuster(completion);
      if (!adjuster) {
        response = fallbackAdjustmentResponse('adjuster_unavailable: AI 微调器未就绪');
      } else {
        response = await adjuster.adjust(ctx.tenantId, { graph, instruction });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response = fallbackAdjustmentResponse(`adjuster_error: ${message}`);
    }
    const saved = await adjustments.create({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      graphId: request.params.id,
      instruction,
      response,
    });
    if (!saved) return reply.code(404).send({ error: 'topology_not_found' });
    return reply.code(201).send(saved);
  });

  app.get<{ Params: { id: string } }>('/api/topologies/:id/adjustments', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'topology_not_found' });
    const graph = await learning.get(ctx.tenantId, request.params.id);
    if (!graph) return reply.code(404).send({ error: 'topology_not_found' });
    return reply.send({ adjustments: await adjustments.list(ctx.tenantId, request.params.id, 100) });
  });

  app.delete<{ Params: { id: string; adjustmentId: string } }>(
    '/api/topologies/:id/adjustments/:adjustmentId',
    async (request, reply) => {
      const ctx = await authorize(request, reply, pool);
      if (!ctx) return;
      if (!isUuid(request.params.id) || !isUuid(request.params.adjustmentId)) {
        return reply.code(404).send({ error: 'adjustment_not_found' });
      }
      const graph = await learning.get(ctx.tenantId, request.params.id);
      if (!graph) return reply.code(404).send({ error: 'topology_not_found' });
      const deleted = await adjustments.delete(ctx.tenantId, request.params.id, request.params.adjustmentId);
      if (!deleted) return reply.code(404).send({ error: 'adjustment_not_found' });
      return reply.send({ ok: true });
    },
  );

  // 注意：通配 /:id 必须放在最后。
  app.get<{ Params: { id: string } }>('/api/topologies/:id', async (request, reply) => {
    const ctx = await authorize(request, reply, pool);
    if (!ctx) return;
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'topology_not_found' });
    const graph = await learning.get(ctx.tenantId, request.params.id);
    if (!graph) return reply.code(404).send({ error: 'topology_not_found' });
    return reply.send(graph);
  });
}
