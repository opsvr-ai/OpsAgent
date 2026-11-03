import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { ScenarioService, type ToolResolver } from '../scenarios/service.js';
import { LongTaskService } from './service.js';

async function context(pool: Pool, request: FastifyRequest): Promise<TenantContext | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await readSession(pool, token);
  if (!session?.selectedTenantId) return null;
  return resolveTenantContext(
    { userId: session.user.id, tenantId: session.selectedTenantId },
    createMembershipRepository(pool),
  );
}

export function registerTaskRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
  tools: ToolResolver,
): void {
  const tasks = new LongTaskService(pool, new ScenarioService(pool, tools));

  app.get('/api/tasks', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'task.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await tasks.list(ctx.tenantId));
  });

  app.post('/api/tasks', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'task.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { title?: unknown; scenarioId?: unknown } | undefined;
    if (typeof body?.title !== 'string' || typeof body.scenarioId !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const task = await tasks.create({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      title: body.title,
      scenarioId: body.scenarioId,
    });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'task.create',
      resource: task.id,
      result: 'success',
      metadata: { scenarioId: task.scenarioId },
    });
    return reply.code(201).send(task);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/approve', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'task.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { decision?: unknown } | undefined;
    if (body?.decision !== 'approve' && body?.decision !== 'reject') {
      return reply.code(400).send({ error: 'invalid_decision' });
    }
    const task = await tasks.approve({
      tenantId: ctx.tenantId,
      taskId: request.params.id,
      userId: ctx.userId,
      decision: body.decision,
    });
    if (!task) return reply.code(404).send({ error: 'task_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'task.approve',
      resource: task.id,
      result: 'success',
      metadata: { decision: body.decision },
    });
    return reply.send(task);
  });
}
