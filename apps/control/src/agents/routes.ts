import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { AgentService } from './service.js';
import { AgentCommandService } from './commands.js';

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
    });
    return reply.code(201).send(registered);
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/heartbeat', async (request, reply) => {
    const body = request.body as { agentKey?: unknown; metrics?: unknown } | undefined;
    if (typeof body?.agentKey !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const metrics =
      typeof body.metrics === 'object' && body.metrics !== null && !Array.isArray(body.metrics)
        ? (body.metrics as Record<string, unknown>)
        : undefined;
    const agent = await agents.heartbeat(request.params.id, body.agentKey, metrics);
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
    const body = request.body as { type?: unknown } | undefined;
    if (
      typeof body?.type !== 'string' ||
      !['diagnostics', 'disk_check', 'memory_check', 'ai_diagnose'].includes(body.type)
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const command = await commands.create({
      tenantId: ctx.tenantId,
      agentId: request.params.id,
      type: body.type,
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
