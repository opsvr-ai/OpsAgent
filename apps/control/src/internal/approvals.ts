import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { sendWebhook } from '../messages/webhook.js';

interface CreateBody {
  tenantId?: unknown;
  runtimeSessionId?: unknown;
  tool?: unknown;
  callId?: unknown;
  reason?: unknown;
  details?: unknown;
}

function authorized(request: FastifyRequest, token?: string): boolean {
  if (!token) return true;
  return request.headers['x-opsagent-token'] === token;
}

export function registerInternalApprovalRoutes(
  app: FastifyInstance,
  pool: Pool,
  token?: string,
): void {
  app.post('/internal/approvals', async (request, reply) => {
    if (!authorized(request, token)) return reply.code(401).send({ error: 'unauthorized' });
    const body = request.body as CreateBody | undefined;
    if (
      typeof body?.tenantId !== 'string' ||
      typeof body.runtimeSessionId !== 'string' ||
      typeof body.tool !== 'string' ||
      typeof body.callId !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const session = await pool.query<{ id: string }>(
      `SELECT id FROM runtime_sessions
       WHERE tenant_id = $1 AND runtime_session_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [body.tenantId, body.runtimeSessionId],
    );
    const sessionId = session.rows[0]?.id;
    if (!sessionId) return reply.code(404).send({ error: 'session_not_found' });

    const details =
      typeof body.details === 'object' && body.details !== null && !Array.isArray(body.details)
        ? body.details
        : {};
    const approval = await pool.query<{ id: string }>(
      `INSERT INTO approvals
         (tenant_id, session_id, runtime_approval_id, action, risk, status, details)
       VALUES ($1, $2, $3, $4, 'R2', 'pending', $5::jsonb) RETURNING id`,
      [body.tenantId, sessionId, body.callId, body.tool, JSON.stringify(details)],
    );
    await pool.query(
      `INSERT INTO messages (tenant_id, title, body, severity)
       VALUES ($1, $2, $3, 'warning')`,
      [body.tenantId, '待审批的运行时操作', `${body.tool} 需要审批`],
    );
    void sendWebhook({
      title: '待审批的运行时操作',
      body: `${body.tool} 需要审批`,
      severity: 'warning',
    });
    return reply.code(201).send({ id: approval.rows[0]?.id });
  });

  app.get<{ Params: { id: string } }>('/internal/approvals/:id', async (request, reply) => {
    if (!authorized(request, token)) return reply.code(401).send({ error: 'unauthorized' });
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM approvals WHERE id = $1',
      [request.params.id],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: 'approval_not_found' });
    return reply.send({ status: row.status });
  });

  app.post<{ Params: { id: string } }>(
    '/internal/approvals/:id/decision',
    async (request, reply) => {
      if (!authorized(request, token)) return reply.code(401).send({ error: 'unauthorized' });
      const body = request.body as { decision?: unknown } | undefined;
      if (body?.decision !== 'approve' && body?.decision !== 'reject') {
        return reply.code(400).send({ error: 'invalid_decision' });
      }
      const result = await pool.query(
        `UPDATE approvals SET status = $1, decided_at = now()
         WHERE id = $2 AND status = 'pending' RETURNING id`,
        [body.decision === 'approve' ? 'approved' : 'rejected', request.params.id],
      );
      if (!result.rows[0]) return reply.code(404).send({ error: 'approval_not_found' });
      return reply.send({ ok: true });
    },
  );
}
