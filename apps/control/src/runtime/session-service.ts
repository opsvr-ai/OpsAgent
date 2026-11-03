import type { RuntimeClient, RuntimeEvent } from '@opsagent/contracts';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';

export interface SessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly runtimeSessionId: string;
  readonly roleView: string;
  readonly status: string;
}

export interface CreateSessionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly roleView: string;
  readonly scenarioId?: string;
}

export interface ApprovalDecisionInput {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly decision: 'approve' | 'deny';
  readonly reason?: string;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  session_id: string;
  runtime_approval_id: string;
  action: string;
  risk: string;
  status: string;
  runtime_session_id: string;
  user_id: string;
}

export class SessionNotFoundError extends Error {
  readonly code = 'session.not_found';
}

export class ApprovalNotFoundError extends Error {
  readonly code = 'approval.not_found';
}

export class SessionService {
  constructor(
    private readonly pool: Pool,
    private readonly runtime: RuntimeClient,
    private readonly audit: AuditWriter,
  ) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const runtimeSession = await this.runtime.startSession({
      tenantId: input.tenantId,
      userId: input.userId,
      roleView: input.roleView,
      ...(input.scenarioId ? { scenarioId: input.scenarioId } : {}),
    });

    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      runtime_session_id: string;
      role_view: string;
      status: string;
    }>(
      `INSERT INTO runtime_sessions (tenant_id, user_id, runtime_session_id, role_view, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id, tenant_id, user_id, runtime_session_id, role_view, status`,
      [input.tenantId, input.userId, runtimeSession.runtimeSessionId, input.roleView],
    );

    const row = result.rows[0];
    if (!row) throw new Error('failed to create runtime session');
    return this.map(row);
  }

  async get(id: string, tenantId: string, userId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      runtime_session_id: string;
      role_view: string;
      status: string;
    }>(
      `SELECT id, tenant_id, user_id, runtime_session_id, role_view, status
       FROM runtime_sessions WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, tenantId, userId],
    );
    const row = result.rows[0];
    return row ? this.map(row) : null;
  }

  async *prompt(
    sessionId: string,
    tenantId: string,
    userId: string,
    text: string,
    idempotencyKey: string,
  ): AsyncIterable<RuntimeEvent> {
    const session = await this.get(sessionId, tenantId, userId);
    if (!session) throw new SessionNotFoundError();

    try {
      for await (const event of this.runtime.prompt(
        session.runtimeSessionId,
        text,
        idempotencyKey,
      )) {
        if (event.type === 'approval.request') {
          const approval = await this.pool.query<{ id: string }>(
            `INSERT INTO approvals (tenant_id, session_id, runtime_approval_id, action, risk, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')
             RETURNING id`,
            [session.tenantId, session.id, event.approvalId, event.action, event.risk],
          );
          const approvalId = approval.rows[0]?.id;
          if (!approvalId) throw new Error('failed to persist approval');
          yield { ...event, approvalId };
          continue;
        }

        if (event.type === 'session.done') {
          await this.updateStatus(session.id, 'completed');
        }
        yield event;
      }
    } catch (error) {
      await this.updateStatus(session.id, 'failed');
      throw error;
    }
  }

  async listApprovals(tenantId: string, userId: string): Promise<Array<{
    id: string;
    action: string;
    risk: string;
    sessionId: string;
    createdAt: string;
  }>> {
    const result = await this.pool.query<{
      id: string;
      action: string;
      risk: string;
      session_id: string;
      created_at: Date;
    }>(
      `SELECT a.id, a.action, a.risk, a.session_id, a.created_at
       FROM approvals a
       JOIN runtime_sessions s ON s.id = a.session_id
       WHERE a.tenant_id = $1 AND s.user_id = $2 AND a.status = 'pending'
       ORDER BY a.created_at DESC`,
      [tenantId, userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      risk: row.risk,
      sessionId: row.session_id,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async respondApproval(input: ApprovalDecisionInput): Promise<void> {
    const result = await this.pool.query<ApprovalRow>(
      `SELECT a.id, a.tenant_id, a.session_id, a.runtime_approval_id, a.action, a.risk, a.status,
              s.runtime_session_id, s.user_id
       FROM approvals a
       JOIN runtime_sessions s ON s.id = a.session_id
       WHERE a.id = $1 AND a.tenant_id = $2 AND s.user_id = $3`,
      [input.approvalId, input.tenantId, input.userId],
    );
    const approval = result.rows[0];
    if (!approval || approval.status !== 'pending') throw new ApprovalNotFoundError();

    try {
      await this.runtime.respondApproval(
        approval.runtime_session_id,
        approval.runtime_approval_id,
        input.decision,
        input.reason,
      );
    } catch (error) {
      // The dsh approval bridge is poll-based: the plugin watches the DB row,
      // so persisting the decision below is the signal. Native headless
      // runtimes have no in-process response channel.
      if (!(error instanceof Error) || error.message !== 'dsh_runtime_approval_not_supported') {
        throw error;
      }
    }

    await this.pool.query(
      `UPDATE approvals
       SET status = $1, decided_at = now(), decided_by = $2, reason = $3
       WHERE id = $4`,
      [input.decision === 'approve' ? 'approved' : 'rejected', input.userId, input.reason ?? null, input.approvalId],
    );
    await this.audit.write({
      tenantId: input.tenantId,
      actorId: input.userId,
      action: 'approval.decide',
      resource: input.approvalId,
      result: 'success',
      metadata: { decision: input.decision, reason: input.reason ?? null },
    });
  }

  private async updateStatus(id: string, status: string): Promise<void> {
    await this.pool.query('UPDATE runtime_sessions SET status = $1 WHERE id = $2', [status, id]);
  }

  private map(row: {
    id: string;
    tenant_id: string;
    user_id: string;
    runtime_session_id: string;
    role_view: string;
    status: string;
  }): SessionRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      runtimeSessionId: row.runtime_session_id,
      roleView: row.role_view,
      status: row.status,
    };
  }
}
