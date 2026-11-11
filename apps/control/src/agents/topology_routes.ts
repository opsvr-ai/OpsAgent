import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { TopologyScope } from '@opsagent/contracts';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext } from '../tenancy/context.js';
import type { TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { AgentConnectionEdgeService } from './connection_edges.js';
import {
  TopologyLearningError,
  TopologyLearningService,
} from './topology_learning.js';
import { TopologyEdgeTagService, normalizeEdgeTagInput } from './topology_tags.js';
import { AccessTrendError, AccessTrendService } from './topology_trends.js';

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

export function registerTopologyRoutes(
  app: FastifyInstance,
  pool: Pool,
  service?: TopologyLearningService,
  modelSecret?: string,
): void {
  const learning = service ?? new TopologyLearningService(pool, modelSecret);
  const edgeSamples = new AgentConnectionEdgeService(pool);
  const edgeTags = new TopologyEdgeTagService(pool);
  const trends = new AccessTrendService(pool, edgeTags);

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
