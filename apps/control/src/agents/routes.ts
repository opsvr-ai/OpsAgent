import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { AgentService, type DiscoveryPayload } from './service.js';
import { AgentCommandService } from './commands.js';
import { getCommandSigners } from './signing.js';
import { AgentEventService, type AgentEventInput } from './events.js';
import { AppHealthService } from './health.js';

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
): void {
  const agents = new AgentService(pool);
  const commands = new AgentCommandService(pool);
  const events = new AgentEventService(pool);
  const health = new AppHealthService(pool);

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
      ...(discovery ? { discovery } : {}),
    });
    const commandSigners = getCommandSigners();
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
    const body = request.body as { agentKey?: unknown; metrics?: unknown; discovery?: unknown } | undefined;
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
    );
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return reply.send(agent);
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
    }
    return reply.send({ events: reported });
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
      !['diagnostics', 'disk_check', 'memory_check', 'ai_diagnose', 'discovery', 'inspect', 'exec'].includes(body.type)
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
      const body = request.body as { agentKey?: unknown; result?: unknown } | undefined;
      if (typeof body?.agentKey !== 'string') {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const command = await commands.complete({
        agentId: request.params.id,
        commandId: request.params.commandId,
        key: body.agentKey,
        result: body.result ?? {},
      });
      if (!command) return reply.code(404).send({ error: 'command_not_found' });
      return reply.send(command);
    },
  );
}
