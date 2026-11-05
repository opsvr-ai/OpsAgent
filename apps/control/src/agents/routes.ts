import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { AgentService, type DiscoveryPayload } from './service.js';
import { AgentCommandService } from './commands.js';
import { getCommandSigners } from './signing.js';
import { AgentEventService, type AgentEventInput } from './events.js';
import { AppHealthService } from './health.js';
import { ModelCompletionService } from '../models/completion.js';
import { ModelProviderService } from '../models/service.js';
import { PatrolPolicyService, DEFAULT_PATROL_POLICY } from './patrol_policy.js';
import { AgentSkillService, type BuiltinSkillPayload } from './skills_service.js';
import { AgentInventoryService } from './inventory_service.js';
import { AgentConnectionService } from './connection_service.js';
import { FaultAnalysisService } from './fault_analysis.js';

function discoveryBody(value: unknown): DiscoveryPayload | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as DiscoveryPayload)
    : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function enrollmentAuthorized(request: FastifyRequest, token?: string): boolean {
  if (!token) return true;
  return request.headers['x-opsagent-enrollment-token'] === token;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  pool: Pool,
  enrollmentToken?: string,
  modelSecret = process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret',
  audit?: AuditWriter,
): void {
  const agents = new AgentService(pool);
  const commands = new AgentCommandService(pool);
  const events = new AgentEventService(pool);
  const health = new AppHealthService(pool);
  const modelCompletion = new ModelCompletionService(new ModelProviderService(pool, modelSecret));
  const patrolPolicies = new PatrolPolicyService(pool);
  const skillService = new AgentSkillService(pool);
  const inventoryService = new AgentInventoryService(pool);
  const connectionService = new AgentConnectionService(pool);
  const faultAnalysis = new FaultAnalysisService(pool, modelSecret);

  app.post('/api/agents/register', async (request, reply) => {
    if (!enrollmentAuthorized(request, enrollmentToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as {
      tenantId?: unknown;
      name?: unknown;
      hostname?: unknown;
      os?: unknown;
      arch?: unknown;
      version?: unknown;
      capabilities?: unknown;
      resultPublicKey?: unknown;
      discovery?: unknown;
    } | undefined;
    if (
      typeof body?.tenantId !== 'string' ||
      typeof body.hostname !== 'string' ||
      typeof body.os !== 'string' ||
      typeof body.arch !== 'string' ||
      typeof body.version !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const discovery = discoveryBody(body.discovery);
    const registered = await agents.register({
      tenantId: body.tenantId,
      name: typeof body.name === 'string' ? body.name : body.hostname,
      hostname: body.hostname,
      os: body.os,
      arch: body.arch,
      version: body.version,
      capabilities: Array.isArray(body.capabilities)
        ? body.capabilities.filter((item): item is string => typeof item === 'string')
        : [],
      ...(typeof body.resultPublicKey === 'string' && body.resultPublicKey.length > 20
        ? { resultPublicKey: body.resultPublicKey }
        : {}),
      ...(discovery ? { discovery } : {}),
    });
    const commandSigners = getCommandSigners();
    const registrationSkills = discovery?.agent && typeof discovery.agent === 'object'
      ? (discovery.agent as { skills?: unknown }).skills
      : undefined;
    if (Array.isArray(registrationSkills)) {
      await skillService.syncBuiltin(
        body.tenantId,
        registrationSkills.filter((item): item is BuiltinSkillPayload => typeof item === 'object' && item !== null),
      ).catch(() => undefined);
    }
    if (discovery?.operations) {
      await inventoryService.sync(body.tenantId, registered.agent.id, discovery.operations).catch(() => undefined);
      await connectionService.sync(
        body.tenantId,
        registered.agent.id,
        (discovery.operations as Record<string, unknown>).connections,
      ).catch(() => undefined);
    }
    return reply.code(201).send({
      ...registered,
      commandPublicKey: commandSigners[0]?.publicKey,
      commandKeyId: commandSigners[0]?.keyId,
      commandPublicKeys: commandSigners.map((item) => ({
        keyId: item.keyId,
        publicKey: item.publicKey,
      })),
    });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/heartbeat', async (request, reply) => {
    const body = request.body as {
      agentKey?: unknown;
      metrics?: unknown;
      discovery?: unknown;
      commandKeyId?: unknown;
      tlsCertExpiresAt?: unknown;
      tlsCertSerial?: unknown;
    } | undefined;
    if (typeof body?.agentKey !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const metrics =
      typeof body.metrics === 'object' && body.metrics !== null && !Array.isArray(body.metrics)
        ? (body.metrics as Record<string, unknown>)
        : undefined;
    const agent = await agents.heartbeat(
      request.params.id,
      body.agentKey,
      metrics,
      discoveryBody(body.discovery),
      typeof body.commandKeyId === 'string' ? body.commandKeyId : undefined,
      typeof body.tlsCertExpiresAt === 'string' ? body.tlsCertExpiresAt : undefined,
      typeof body.tlsCertSerial === 'string' ? body.tlsCertSerial : undefined,
    );
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    const discoveryAgent = body.discovery && typeof body.discovery === 'object'
      ? (body.discovery as { agent?: { skills?: unknown } }).agent
      : undefined;
    if (discoveryAgent && Array.isArray(discoveryAgent.skills)) {
      const tenant = await pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM agents WHERE id = $1',
        [request.params.id],
      );
      if (tenant.rows[0]) {
        await skillService.syncBuiltin(
          tenant.rows[0].tenant_id,
          discoveryAgent.skills.filter((item): item is BuiltinSkillPayload => typeof item === 'object' && item !== null),
        ).catch(() => undefined);
        const operations = body.discovery && typeof body.discovery === 'object'
          ? (body.discovery as { operations?: unknown }).operations
          : undefined;
        if (operations) {
          await inventoryService.sync(tenant.rows[0].tenant_id, request.params.id, operations).catch(() => undefined);
          await connectionService.sync(
            tenant.rows[0].tenant_id,
            request.params.id,
            (operations as Record<string, unknown>).connections,
          ).catch(() => undefined);
        }
      }
    }
    const commandSigners = getCommandSigners();
    return reply.send({
      ...agent,
      commandKeyId: commandSigners[0]?.keyId,
      commandPublicKeys: commandSigners.map((item) => ({
        keyId: item.keyId,
        publicKey: item.publicKey,
      })),
    });
  });

  app.get('/api/agents/command-keys', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const signers = getCommandSigners();
    const keyIds = new Set(signers.map((item) => item.keyId));
    const list = await agents.list(ctx.tenantId);
    return reply.send({
      keys: signers.map((item, index) => ({
        keyId: item.keyId,
        publicKey: item.publicKey,
        active: index === 0,
      })),
      agents: list.map((agent) => ({
        id: agent.id,
        hostname: agent.hostname,
        commandKeyId: agent.commandKeyId,
        valid: agent.commandKeyId ? keyIds.has(agent.commandKeyId) : null,
      })),
    });
  });

  app.get('/api/agents', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await agents.list(ctx.tenantId));
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/events', async (request, reply) => {
    const body = request.body as {
      agentKey?: unknown;
      events?: unknown;
      resolveMissing?: unknown;
      diagnostics?: unknown;
    } | undefined;
    if (typeof body?.agentKey !== 'string' || !Array.isArray(body.events)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const diagnostics = typeof body.diagnostics === 'object' && body.diagnostics !== null && !Array.isArray(body.diagnostics)
      ? body.diagnostics as Record<string, unknown>
      : {};
    const reported = await events.report(
      request.params.id,
      body.agentKey,
      body.events.filter((item): item is AgentEventInput => typeof item === 'object' && item !== null),
      body.resolveMissing === true,
      diagnostics,
    );
    if (!reported) return reply.code(404).send({ error: 'agent_not_found' });
    const triggerEvent = reported.find((event) => event.status === 'open');
    if (triggerEvent) {
      try {
        await health.triggerForAgentEvent(request.params.id, triggerEvent.id);
      } catch (error) {
        request.log.warn({ err: error }, 'app health check failed');
      }
      void faultAnalysis.triggerForEvent(request.params.id, triggerEvent.id).catch((error) => {
        request.log.warn({ err: error }, 'fault analysis trigger failed');
      });
    }
    return reply.send({ events: reported });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/analyze', async (request, reply) => {
    if (!enrollmentAuthorized(request, enrollmentToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as {
      agentKey?: unknown;
      question?: unknown;
      metrics?: unknown;
      events?: unknown;
    } | undefined;
    if (typeof body?.agentKey !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const agent = await pool.query<{ tenant_id: string; hostname: string }>(
      'SELECT tenant_id, hostname FROM agents WHERE id = $1 AND agent_key = $2',
      [request.params.id, body.agentKey],
    );
    const row = agent.rows[0];
    if (!row) return reply.code(404).send({ error: 'agent_not_found' });
    const metrics = typeof body.metrics === 'object' && body.metrics !== null ? body.metrics : {};
    const patrolEvents = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
    try {
      const analysis = await modelCompletion.complete({
        tenantId: row.tenant_id,
        system: [
          '你是 OpsAgent 主机自主巡航根因分析器。',
          '根据给定的主机指标、阈值和异常事件给出：是否异常、根因判断、最可能原因、建议的下一步检查或处置。',
          '只使用提供的数据，不编造；回答简洁，使用简体中文，控制在 300 字以内。',
        ].join('\n'),
        prompt: JSON.stringify({
          hostname: row.hostname,
          question: typeof body.question === 'string' ? body.question : '请分析当前主机异常',
          metrics,
          events: patrolEvents,
        }).slice(0, 20_000),
        maxTokens: 700,
      });
      request.log.info({ agentId: row.hostname, event: 'agent_analyze', chars: analysis.length }, 'agent analysis completed');
      return reply.send({ analysis });
    } catch (error) {
      request.log.warn({ err: error, agentId: row.hostname }, 'agent analysis failed');
      return reply.code(503).send({ error: 'model_unavailable' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/patrol-policy', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const policy = await patrolPolicies.get(ctx.tenantId, request.params.id);
    if (!policy) return reply.code(404).send({ error: 'agent_not_found' });
    return reply.send(policy);
  });

  app.put<{ Params: { id: string } }>('/api/agents/:id/patrol-policy', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as {
      enabled?: unknown;
      intervalSeconds?: unknown;
      diskFreePct?: unknown;
      memLoadPct?: unknown;
      load1?: unknown;
    } | undefined;
    if (
      typeof body?.enabled !== 'boolean' ||
      typeof body.intervalSeconds !== 'number' ||
      typeof body.diskFreePct !== 'number' ||
      typeof body.memLoadPct !== 'number' ||
      typeof body.load1 !== 'number'
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const policy = await patrolPolicies.upsert(ctx.tenantId, request.params.id, {
      enabled: body.enabled,
      intervalSeconds: body.intervalSeconds,
      diskFreePct: body.diskFreePct,
      memLoadPct: body.memLoadPct,
      load1: body.load1,
    });
    if (!policy) return reply.code(404).send({ error: 'agent_not_found' });
    await audit?.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'agent.patrol.update',
      resource: request.params.id,
      result: 'success',
      metadata: {
        enabled: policy.enabled,
        intervalSeconds: policy.intervalSeconds,
        diskFreePct: policy.diskFreePct,
        memLoadPct: policy.memLoadPct,
        load1: policy.load1,
      },
    });
    return reply.send(policy);
  });

  app.get<{ Params: { id: string }; Querystring: { agentKey?: string } }>(
    '/api/agents/:id/patrol-policy/agent',
    async (request, reply) => {
      if (!request.query.agentKey) return reply.code(400).send({ error: 'agent_key_required' });
      const agent = await pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM agents WHERE id = $1 AND agent_key = $2',
        [request.params.id, request.query.agentKey],
      );
      const row = agent.rows[0];
      if (!row) return reply.code(404).send({ error: 'agent_not_found' });
      const policy = await patrolPolicies.get(row.tenant_id, request.params.id);
      const watch = await inventoryService.watchlist(row.tenant_id, request.params.id);
      return reply.send({
        ...(policy ?? {
          agentId: request.params.id,
          ...DEFAULT_PATROL_POLICY,
          updatedAt: null,
        }),
        watch,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/agents/:id/inventory', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await inventoryService.list(ctx.tenantId, request.params.id));
  });

  app.patch<{ Params: { id: string; itemId: string } }>('/api/agents/:id/inventory/:itemId', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { important?: unknown; monitored?: unknown; appSystemId?: unknown } | undefined;
    if (body?.important !== undefined && typeof body.important !== 'boolean') return reply.code(400).send({ error: 'invalid_request' });
    if (body?.monitored !== undefined && typeof body.monitored !== 'boolean') return reply.code(400).send({ error: 'invalid_request' });
    const updated = await inventoryService.update(ctx.tenantId, request.params.itemId, {
      ...(typeof body?.important === 'boolean' ? { important: body.important } : {}),
      ...(typeof body?.monitored === 'boolean' ? { monitored: body.monitored } : {}),
      ...(typeof body?.appSystemId === 'string' ? { appSystemId: body.appSystemId } : {}),
    });
    if (!updated) return reply.code(404).send({ error: 'inventory_not_found' });
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/api/agents/:id/inventory/:itemId', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const hidden = await inventoryService.hide(ctx.tenantId, request.params.id, request.params.itemId, ctx.userId);
    if (!hidden) return reply.code(404).send({ error: 'inventory_not_found' });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string; itemId: string } }>('/api/agents/:id/inventory/:itemId/promote', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { kind?: unknown } | undefined;
    if (body?.kind !== 'ops_tool') return reply.code(400).send({ error: 'invalid_target_kind' });
    const updated = await inventoryService.promote(ctx.tenantId, request.params.id, request.params.itemId, 'ops_tool');
    if (updated === 0) return reply.code(404).send({ error: 'inventory_not_found' });
    return reply.send({ ok: true, updated });
  });

  app.get('/api/app-systems/health', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await health.latest(ctx.tenantId));
  });

  app.get<{ Params: { id: string } }>('/api/app-systems/:id/health', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await health.latest(ctx.tenantId, request.params.id));
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/events', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await events.list(ctx.tenantId, request.params.id));
  });

  app.get<{
    Querystring: {
      query?: string;
      status?: string;
      appSystemId?: string;
      os?: string;
      page?: string;
      pageSize?: string;
    };
  }>('/api/agents/fleet', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const appSystemId = request.query.appSystemId?.trim() || undefined;
    if (appSystemId && !isUuid(appSystemId)) {
      return reply.code(400).send({ error: 'invalid_app_system' });
    }
    const page = Number.parseInt(request.query.page ?? '1', 10);
    const pageSize = Number.parseInt(request.query.pageSize ?? '20', 10);
    const fleet = await agents.fleet(ctx.tenantId, {
      ...(request.query.query ? { query: request.query.query } : {}),
      ...(request.query.status ? { status: request.query.status } : {}),
      ...(appSystemId ? { appSystemId } : {}),
      ...(request.query.os ? { os: request.query.os } : {}),
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    });
    return reply.send({ ...fleet, alerts: await events.openForTenant(ctx.tenantId) });
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/key-history', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const agent = await agents.get(request.params.id, ctx.tenantId);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return reply.send(await agents.keyHistory(ctx.tenantId, request.params.id));
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const agent = await agents.get(request.params.id, ctx.tenantId);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return reply.send(agent);
  });

  app.patch<{ Params: { id: string } }>('/api/agents/:id/app-system', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { appSystemId?: unknown } | undefined;
    const appSystemId = body?.appSystemId ?? null;
    if (appSystemId !== null && (typeof appSystemId !== 'string' || !isUuid(appSystemId))) {
      return reply.code(400).send({ error: 'invalid_app_system' });
    }
    const updated = await agents.assignAppSystem(ctx.tenantId, request.params.id, appSystemId);
    if (!updated) return reply.code(404).send({ error: 'agent_or_app_system_not_found' });
    return reply.send(updated);
  });

  app.get('/api/app-systems', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await agents.listAppSystems(ctx.tenantId));
  });

  app.post('/api/app-systems', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as {
      code?: unknown; name?: unknown; owner?: unknown; criticality?: unknown;
    } | undefined;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/i.test(code) || !name) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const criticality = typeof body?.criticality === 'string' && /^P[0-4]$/.test(body.criticality) ? body.criticality : 'P2';
    try {
      const created = await pool.query(
        `INSERT INTO app_systems (tenant_id, code, name, owner, criticality)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, name, owner, criticality`,
        [ctx.tenantId, code, name, typeof body?.owner === 'string' ? body.owner : null, criticality],
      );
      return reply.code(201).send(created.rows[0]);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        return reply.code(409).send({ error: 'app_system_exists' });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/commands', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { type?: unknown; input?: unknown } | undefined;
    if (
      typeof body?.type !== 'string' ||
      !['diagnostics', 'disk_check', 'memory_check', 'ai_diagnose', 'discovery', 'inspect', 'exec', 'skills', 'memory', 'skill'].includes(body.type)
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const input = typeof body.input === 'object' && body.input !== null && !Array.isArray(body.input)
      ? body.input as Record<string, unknown>
      : {};
    const command = await commands.create({
      tenantId: ctx.tenantId,
      agentId: request.params.id,
      type: body.type,
      input,
    });
    if (!command) return reply.code(404).send({ error: 'agent_not_found' });
    return reply.code(201).send(command);
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/commands', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const session = await readSession(pool, token);
    if (!session?.selectedTenantId) return reply.code(401).send({ error: 'unauthorized' });
    const ctx = await resolveTenantContext(
      { userId: session.user.id, tenantId: session.selectedTenantId },
      createMembershipRepository(pool),
    );
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await commands.list(ctx.tenantId, request.params.id));
  });

  app.get<{ Params: { id: string }; Querystring: { agentKey?: string } }>(
    '/api/agents/:id/commands/pending',
    async (request, reply) => {
      if (!request.query.agentKey) return reply.code(400).send({ error: 'agent_key_required' });
      const command = await commands.pending(request.params.id, request.query.agentKey);
      if (!command) return reply.code(204).send();
      return reply.send(command);
    },
  );

  app.post<{ Params: { id: string; commandId: string } }>(
    '/api/agents/:id/commands/:commandId/complete',
    async (request, reply) => {
      const body = request.body as {
        agentKey?: unknown;
        result?: unknown;
        resultSigned?: unknown;
        resultSignature?: unknown;
      } | undefined;
      if (typeof body?.agentKey !== 'string') {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      try {
        const command = await commands.complete({
          agentId: request.params.id,
          commandId: request.params.commandId,
          key: body.agentKey,
          result: body.result ?? {},
          ...(typeof body.resultSigned === 'string' ? { resultSigned: body.resultSigned } : {}),
          ...(typeof body.resultSignature === 'string' ? { resultSignature: body.resultSignature } : {}),
        });
        if (!command) return reply.code(404).send({ error: 'command_not_found' });
        if (command.type === 'discovery') {
          const result = typeof command.result === 'object' && command.result !== null
            ? command.result as { discovery?: { operations?: unknown } }
            : {};
          if (result.discovery?.operations) {
            const tenant = await pool.query<{ tenant_id: string }>(
              'SELECT tenant_id FROM agents WHERE id = $1',
              [request.params.id],
            );
            if (tenant.rows[0]) {
              await inventoryService.sync(
                tenant.rows[0].tenant_id,
                request.params.id,
                result.discovery.operations,
              ).catch(() => undefined);
              await connectionService.sync(
                tenant.rows[0].tenant_id,
                request.params.id,
                (result.discovery.operations as Record<string, unknown>).connections,
              ).catch(() => undefined);
            }
          }
        }
        return reply.send(command);
      } catch (error) {
        if (error instanceof Error && (error.message === 'invalid_result_signature' || error.message === 'result_signature_required' || error.message === 'invalid_result_payload')) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
