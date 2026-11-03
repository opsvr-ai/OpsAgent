import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { MemberService } from './service.js';

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

export function registerMemberRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const members = new MemberService(pool);

  app.get('/api/members', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'tenant.member.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await members.list(ctx.tenantId));
  });

  app.patch<{ Params: { userId: string } }>(
    '/api/members/:userId/roles',
    async (request, reply) => {
      const ctx = await context(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'tenant.member.manage');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }
      const body = request.body as { roleIds?: unknown } | undefined;
      if (
        !Array.isArray(body?.roleIds) ||
        !body.roleIds.every((item): item is string => typeof item === 'string')
      ) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      try {
        const updated = await members.setRoles({
          tenantId: ctx.tenantId,
          userId: request.params.userId,
          roleIds: body.roleIds,
        });
        if (!updated) return reply.code(400).send({ error: 'unknown_roles' });
        await audit.write({
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'member.roles.update',
          resource: updated.userId,
          result: 'success',
          metadata: { roles: updated.roles },
        });
        return reply.send(updated);
      } catch (error) {
        if (error instanceof Error && error.message === 'last_tenant_admin') {
          return reply.code(409).send({ error: 'last_tenant_admin' });
        }
        throw error;
      }
    },
  );
}
