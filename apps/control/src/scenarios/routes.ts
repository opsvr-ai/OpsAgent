import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { ScenarioService, type ScenarioDefinition, type ToolResolver } from './service.js';
import { ScenarioShareService } from './shares.js';

interface CreateScenarioBody {
  name?: unknown;
  description?: unknown;
  definition?: unknown;
}

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

export function registerScenarioRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
  tools: ToolResolver,
): void {
  const scenarios = new ScenarioService(pool, tools);
  const shares = new ScenarioShareService(pool);

  app.get('/api/scenarios', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(await scenarios.list(ctx.tenantId));
  });

  app.post('/api/scenarios', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.publish');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }

    const body = request.body as CreateScenarioBody | undefined;
    const definition = body?.definition as ScenarioDefinition | undefined;
    if (
      typeof body?.name !== 'string' ||
      !definition ||
      !Array.isArray(definition.steps) ||
      definition.steps.length === 0
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    try {
      const created = await scenarios.create({
        tenantId: ctx.tenantId,
        name: body.name,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        definition,
      });
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'scenario.create',
        resource: created.id,
        result: 'success',
        metadata: { name: created.name, steps: created.definition.steps.length },
      });
      return reply.code(201).send(created);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        return reply.code(409).send({ error: 'scenario_name_exists' });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/scenarios/:id/run', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.run');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }

    const result = await scenarios.run(ctx.tenantId, request.params.id);
    if (!result) return reply.code(404).send({ error: 'scenario_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'scenario.run',
      resource: request.params.id,
      result: result.status === 'success' ? 'success' : 'failure',
      metadata: { steps: result.results.length },
    });
    return reply.send(result);
  });

  app.patch<{ Params: { id: string } }>('/api/scenarios/:id/status', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.publish');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }

    const body = request.body as { status?: unknown } | undefined;
    if (body?.status !== 'draft' && body?.status !== 'published' && body?.status !== 'archived') {
      return reply.code(400).send({ error: 'invalid_status' });
    }

    const scenario = await scenarios.setStatus(ctx.tenantId, request.params.id, body.status);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'scenario.publish',
      resource: scenario.id,
      result: 'success',
      metadata: { status: scenario.status },
    });
    return reply.send(scenario);
  });

  app.patch<{ Params: { id: string } }>('/api/scenarios/:id/schedule', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.publish');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }

    const body = request.body as { intervalMinutes?: unknown } | undefined;
    if (
      body?.intervalMinutes !== null &&
      (typeof body?.intervalMinutes !== 'number' ||
        !Number.isInteger(body.intervalMinutes) ||
        body.intervalMinutes < 1 ||
        body.intervalMinutes > 10_080)
    ) {
      return reply.code(400).send({ error: 'invalid_interval' });
    }

    await scenarios.setSchedule(ctx.tenantId, request.params.id, body.intervalMinutes);
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'scenario.schedule',
      resource: request.params.id,
      result: 'success',
      metadata: { intervalMinutes: body.intervalMinutes },
    });
    return reply.send({ ok: true, intervalMinutes: body.intervalMinutes });
  });

  app.get<{ Params: { id: string } }>('/api/scenarios/:id/runs', async (request, reply) => {    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.run');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const scenario = await scenarios.get(ctx.tenantId, request.params.id);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    return reply.send(await scenarios.listRuns(ctx.tenantId, request.params.id));
  });

  app.get<{ Params: { id: string } }>('/api/scenario-runs/:id', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.run');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const run = await scenarios.getRun(ctx.tenantId, request.params.id);
    if (!run) return reply.code(404).send({ error: 'scenario_run_not_found' });
    return reply.send(run);
  });

  app.post<{ Params: { id: string } }>('/api/scenarios/:id/share', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.publish');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { scope?: unknown } | undefined;
    if (body?.scope !== 'tenant' && body?.scope !== 'platform') {
      return reply.code(400).send({ error: 'invalid_scope' });
    }
    const scenario = await scenarios.get(ctx.tenantId, request.params.id);
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });

    const share = await shares.request({
      tenantId: ctx.tenantId,
      scenarioId: scenario.id,
      requestedBy: ctx.userId,
      scope: body.scope,
    });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'scenario.share',
      resource: share.id,
      result: 'success',
      metadata: { scope: share.scope },
    });
    return reply.code(201).send(share);
  });

  app.get('/api/shares', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.publish');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await shares.list(ctx.tenantId));
  });

  app.post<{ Params: { id: string } }>('/api/shares/:id/review', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'scenario.publish');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { decision?: unknown; reason?: unknown } | undefined;
    if (body?.decision !== 'approve' && body?.decision !== 'reject') {
      return reply.code(400).send({ error: 'invalid_decision' });
    }
    const share = await shares.review({
      tenantId: ctx.tenantId,
      shareId: request.params.id,
      reviewerId: ctx.userId,
      decision: body.decision,
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    });
    if (!share) return reply.code(404).send({ error: 'share_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'scenario.share.review',
      resource: share.id,
      result: 'success',
      metadata: { decision: body.decision, scope: share.scope },
    });
    return reply.send(share);
  });
}
