import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { AuditService } from './service.js';

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

export function registerAuditRoutes(app: FastifyInstance, pool: Pool): void {
  const audit = new AuditService(pool);

  app.get<{ Querystring: { limit?: string; action?: string; result?: string } }>(
    '/api/audit',
    async (request, reply) => {
      const ctx = await context(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'audit.read');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }

      const requested = Number.parseInt(request.query.limit ?? '50', 10);
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 50;
      return reply.send(
        await audit.list(ctx.tenantId, limit, {
          ...(request.query.action ? { action: request.query.action } : {}),
          ...(request.query.result ? { result: request.query.result } : {}),
        }),
      );
    },
  );

  app.get('/api/audit/export', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'audit.read');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const csv = await audit.exportCsv(ctx.tenantId);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="audit.csv"')
      .send(csv);
  });
}
