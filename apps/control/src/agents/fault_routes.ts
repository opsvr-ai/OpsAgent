import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { FaultAnalysisService } from './fault_analysis.js';

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

export function registerFaultAnalysisRoutes(
  app: FastifyInstance,
  pool: Pool,
  modelSecret = process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret',
): void {
  const faults = new FaultAnalysisService(pool, modelSecret);

  app.get('/api/fault-analyses', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await faults.list(ctx.tenantId));
  });

  app.get<{ Params: { id: string } }>('/api/fault-analyses/:id', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const analysis = await faults.get(ctx.tenantId, request.params.id);
    if (!analysis) return reply.code(404).send({ error: 'analysis_not_found' });
    return reply.send(analysis);
  });

  app.post('/api/fault-analyses', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { appSystemId?: unknown } | undefined;
    if (typeof body?.appSystemId !== 'string') return reply.code(400).send({ error: 'app_system_required' });
    try {
      const id = await faults.triggerForAppSystem(ctx.tenantId, body.appSystemId, ctx.userId);
      return reply.code(202).send({ id });
    } catch {
      return reply.code(404).send({ error: 'app_system_not_found' });
    }
  });
}
