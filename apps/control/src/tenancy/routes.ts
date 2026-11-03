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

      const [metrics, incidents, sessions] = await Promise.all([
        pool.query<{
          connectors: string;
          incidents_open: string;
          scenarios: string;
          pending_approvals: string;
          active_sessions: string;
          agents_online: string;
          agents_total: string;
          tasks_active: string;
          messages_unread: string;
        }>(
          `SELECT
             (SELECT count(*) FROM connectors WHERE tenant_id = $1) AS connectors,
             (SELECT count(*) FROM incidents WHERE tenant_id = $1 AND status NOT IN ('resolved', 'closed')) AS incidents_open,
             (SELECT count(*) FROM scenarios WHERE tenant_id = $1) AS scenarios,
             (SELECT count(*) FROM approvals WHERE tenant_id = $1 AND status = 'pending') AS pending_approvals,
             (SELECT count(*) FROM runtime_sessions WHERE tenant_id = $1 AND status = 'active') AS active_sessions,
             (SELECT count(*) FROM agents WHERE tenant_id = $1 AND status = 'online') AS agents_online,
             (SELECT count(*) FROM agents WHERE tenant_id = $1) AS agents_total,
             (SELECT count(*) FROM long_tasks WHERE tenant_id = $1 AND status IN ('queued', 'running', 'awaiting_approval')) AS tasks_active,
             (SELECT count(*) FROM messages WHERE tenant_id = $1 AND read_at IS NULL) AS messages_unread`,
          [context.tenantId],
        ),
        pool.query<{ id: string; title: string; severity: string; status: string }>(
          `SELECT id, title, severity, status FROM incidents
           WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 4`,
          [context.tenantId],
        ),
        pool.query<{ id: string; role_view: string; status: string }>(
          `SELECT id, role_view, status FROM runtime_sessions
           WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 4`,
          [context.tenantId],
        ),
      ]);
      const row = metrics.rows[0];

      return reply.send({
        tenantId: context.tenantId,
        roleView: context.roleView,
        cards: [
          { id: 'incidents', title: '事件指挥' },
          { id: 'agents', title: '服务器 Agent' },
          { id: 'knowledge', title: '知识中心' },
        ],
        metrics: {
          connectors: Number(row?.connectors ?? 0),
          incidentsOpen: Number(row?.incidents_open ?? 0),
          scenarios: Number(row?.scenarios ?? 0),
          pendingApprovals: Number(row?.pending_approvals ?? 0),
          activeSessions: Number(row?.active_sessions ?? 0),
          agentsOnline: Number(row?.agents_online ?? 0),
          agentsTotal: Number(row?.agents_total ?? 0),
          tasksActive: Number(row?.tasks_active ?? 0),
          messagesUnread: Number(row?.messages_unread ?? 0),
        },
        recentIncidents: incidents.rows,
        recentSessions: sessions.rows.map((item) => ({
          id: item.id,
          roleView: item.role_view,
          status: item.status,
        })),
      });
    } catch (error) {
      if (error instanceof TenantAccessDeniedError) {
        return reply.code(403).send({ error: 'tenant_access_denied' });
      }
      throw error;
    }
  });
}
