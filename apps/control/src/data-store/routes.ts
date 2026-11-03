import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { DataStoreService } from './service.js';

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

export function registerDataStoreRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const data = new DataStoreService(pool);

  app.get('/api/data-store', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'data.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await data.stats(ctx.tenantId));
  });

  app.post('/api/data-store/cleanup', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'data.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { beforeDays?: unknown; dryRun?: unknown } | undefined;
    const beforeDays = typeof body?.beforeDays === 'number' ? body.beforeDays : 30;
    const dryRun = body?.dryRun !== false;
    const result = await data.cleanup({ tenantId: ctx.tenantId, beforeDays, dryRun });
    if (!dryRun) {
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'data.cleanup',
        result: 'success',
        metadata: { count: result.count, bytes: result.bytes },
      });
    }
    return reply.send(result);
  });
}
