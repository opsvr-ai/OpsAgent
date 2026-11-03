import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import {
  SESSION_COOKIE,
  hashSessionToken,
  readSession,
} from '../auth/session.js';
import {
  TenantAccessDeniedError,
  resolveTenantContext,
} from '../tenancy/context.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';

function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE];
}

export function registerTenantRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const memberships = createMembershipRepository(pool);

  app.post<{ Params: { id: string } }>('/api/tenants/:id/select', async (request, reply) => {
    const token = sessionToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });

    const session = await readSession(pool, token);
    if (!session) return reply.code(401).send({ error: 'unauthorized' });

    try {
      await resolveTenantContext(
        { userId: session.user.id, tenantId: request.params.id },
        memberships,
      );
    } catch (error) {
      if (error instanceof TenantAccessDeniedError) {
        await audit.write({
          tenantId: request.params.id,
          actorId: session.user.id,
          action: 'tenant.access.denied',
          resource: request.params.id,
          result: 'denied',
          metadata: { source: 'tenant_select' },
        });
        return reply.code(403).send({ error: 'tenant_access_denied' });
      }
      throw error;
    }

    await pool.query(
      'UPDATE auth_sessions SET selected_tenant_id = $1 WHERE token_hash = $2',
      [request.params.id, hashSessionToken(token)],
    );
    await audit.write({
      tenantId: request.params.id,
      actorId: session.user.id,
      action: 'tenant.select',
      resource: request.params.id,
      result: 'success',
      metadata: { source: 'api' },
    });
    return reply.send({ ok: true, tenantId: request.params.id });
  });

  app.get('/api/home', async (request, reply) => {
    const token = sessionToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });

    const session = await readSession(pool, token);
    if (!session) return reply.code(401).send({ error: 'unauthorized' });
    if (!session.selectedTenantId) {
      return reply.code(400).send({ error: 'tenant_required' });
    }

    try {
      const context = await resolveTenantContext(
        { userId: session.user.id, tenantId: session.selectedTenantId },
        memberships,
      );
      const tenant = await pool.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [
        context.tenantId,
      ]);
      if (!tenant.rows[0]) return reply.code(403).send({ error: 'tenant_access_denied' });

      return reply.send({
        tenantId: context.tenantId,
        roleView: context.roleView,
        cards: [
          { id: 'incidents', title: '事件指挥' },
          { id: 'agents', title: '服务器 Agent' },
          { id: 'knowledge', title: '知识中心' },
        ],
      });
    } catch (error) {
      if (error instanceof TenantAccessDeniedError) {
        return reply.code(403).send({ error: 'tenant_access_denied' });
      }
      throw error;
    }
  });
}
