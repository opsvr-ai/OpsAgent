import type { PermissionMode, RuntimeClient, RuntimeEvent } from '@opsagent/contracts';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { PlatformAssistant } from '../assistant/platform.js';

export interface SessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly runtimeSessionId: string;
  readonly dshSessionId?: string;
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
  private readonly platform: PlatformAssistant;

  constructor(
    private readonly pool: Pool,
    private readonly runtime: RuntimeClient,
    private readonly audit: AuditWriter,
  ) {
    this.platform = new PlatformAssistant(pool);
  }

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
      dsh_session_id: string | null;
      role_view: string;
      status: string;
    }>(
      `INSERT INTO runtime_sessions (tenant_id, user_id, runtime_session_id, role_view, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id, tenant_id, user_id, runtime_session_id, dsh_session_id, role_view, status`,
      [input.tenantId, input.userId, runtimeSession.runtimeSessionId, input.roleView],
    );

    const row = result.rows[0];
    if (!row) throw new Error('failed to create runtime session');
    return this.map(row);
  }

  async list(tenantId: string, userId: string): Promise<Array<{
    id: string;
    title: string;
    roleView: string;
    status: string;
    createdAt: string;
    lastActivityAt: string;
    messageCount: number;
  }>> {
    const result = await this.pool.query<{
      id: string;
      role_view: string;
      status: string;
      created_at: Date;
      title: string;
      last_activity_at: Date;
      message_count: number;
    }>(
      `SELECT s.id, s.role_view, s.status, s.created_at,
         COALESCE((
           SELECT t.payload->>'text' FROM session_transcripts t
           WHERE t.session_id = s.id AND t.role = 'user'
           ORDER BY t.created_at, t.id LIMIT 1
         ), '新会话') AS title,
         COALESCE((
           SELECT max(t.created_at) FROM session_transcripts t WHERE t.session_id = s.id
         ), s.created_at) AS last_activity_at,
         (SELECT count(*)::int FROM session_transcripts t WHERE t.session_id = s.id) AS message_count
       FROM runtime_sessions s
       WHERE s.tenant_id = $1 AND s.user_id = $2
         AND EXISTS (SELECT 1 FROM session_transcripts t WHERE t.session_id = s.id)
       ORDER BY last_activity_at DESC
       LIMIT 50`,
      [tenantId, userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      roleView: row.role_view,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      lastActivityAt: row.last_activity_at.toISOString(),
      messageCount: row.message_count,
    }));
  }

  async transcript(id: string, tenantId: string, userId: string): Promise<Array<
    | { readonly id: string; readonly kind: 'user'; readonly text: string; readonly at: string }
    | { readonly id: string; readonly kind: 'event'; readonly event: RuntimeEvent; readonly at: string }
  >> {
    const session = await this.get(id, tenantId, userId);
    if (!session) throw new SessionNotFoundError();
    const result = await this.pool.query<{
      id: string;
      role: 'user' | 'event';
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, role, payload, created_at FROM session_transcripts
       WHERE session_id = $1 AND tenant_id = $2
       ORDER BY created_at, id`,
      [id, tenantId],
    );
    return result.rows.map((row) =>
      row.role === 'user'
        ? {
            id: String(row.id),
            kind: 'user' as const,
            text: typeof row.payload.text === 'string' ? row.payload.text : '',
            at: row.created_at.toISOString(),
          }
        : {
            id: String(row.id),
            kind: 'event' as const,
            event: row.payload as unknown as RuntimeEvent,
            at: row.created_at.toISOString(),
          },
    );
  }

  async get(id: string, tenantId: string, userId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      runtime_session_id: string;
      dsh_session_id: string | null;
      role_view: string;
      status: string;
    }>(
      `SELECT id, tenant_id, user_id, runtime_session_id, dsh_session_id, role_view, status
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
    permissionMode?: PermissionMode,
    modelId?: string,
  ): AsyncIterable<RuntimeEvent> {
    const session = await this.get(sessionId, tenantId, userId);
    if (!session) throw new SessionNotFoundError();

    if (permissionMode) {
      await this.pool.query('UPDATE runtime_sessions SET permission_mode = $1 WHERE id = $2', [
        permissionMode,
        session.id,
      ]);
    }
    await this.updateStatus(session.id, 'active');

    if (this.runtime.attachSession) {
      await this.runtime.attachSession(
        session.runtimeSessionId,
        { tenantId, userId },
        session.dshSessionId,
      );
    }
    await this.appendTranscript(session.id, tenantId, 'user', { text });

    const platformPlan = await this.platform.detect(tenantId, text);
    if (platformPlan) {
      try {
        for await (const event of this.platform.execute(platformPlan, tenantId, session.runtimeSessionId)) {
          await this.appendTranscript(session.id, tenantId, 'event', event as unknown as Record<string, unknown>);
          if (event.type === 'session.done') {
            await this.cancelPendingApprovals(session.id);
            await this.updateStatus(session.id, 'completed');
          }
          yield event;
        }
      } catch (error) {
        await this.updateStatus(session.id, 'failed');
        throw error;
      }
      return;
    }

    try {
      for await (const event of this.runtime.prompt(
        session.runtimeSessionId,
        text,
        idempotencyKey,
        permissionMode || modelId
          ? {
              ...(permissionMode ? { permissionMode } : {}),
              ...(modelId ? { modelId } : {}),
            }
          : undefined,
      )) {
        await this.appendTranscript(session.id, tenantId, 'event', event as unknown as Record<string, unknown>);
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
          await this.cancelPendingApprovals(session.id);
          await this.updateStatus(session.id, 'completed');
        }
        yield event;
      }
    } catch (error) {
      await this.cancelPendingApprovals(session.id);
      await this.updateStatus(session.id, 'failed');
      throw error;
    } finally {
      const dshSessionId = this.runtime.getSessionRef?.(session.runtimeSessionId);
      if (dshSessionId && dshSessionId !== session.dshSessionId) {
        await this.pool.query(
          'UPDATE runtime_sessions SET dsh_session_id = $1 WHERE id = $2',
          [dshSessionId, session.id],
        );
      }
    }
  }

  private async appendTranscript(
    sessionId: string,
    tenantId: string,
    role: 'user' | 'event',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_transcripts (tenant_id, session_id, role, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [tenantId, sessionId, role, JSON.stringify(payload)],
    );
  }

  private async cancelPendingApprovals(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE approvals SET status = 'cancelled', decided_at = now()
       WHERE session_id = $1 AND status = 'pending'`,
      [sessionId],
    );
  }

  async listApprovals(tenantId: string, userId: string, sessionId?: string): Promise<Array<{
    id: string;
    action: string;
    risk: string;
    sessionId: string;
    details: Readonly<Record<string, unknown>>;
    createdAt: string;
  }>> {
    const result = await this.pool.query<{
      id: string;
      action: string;
      risk: string;
      session_id: string;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT a.id, a.action, a.risk, a.session_id, a.details, a.requested_at AS created_at
       FROM approvals a
       JOIN runtime_sessions s ON s.id = a.session_id
       WHERE a.tenant_id = $1 AND s.user_id = $2 AND a.status = 'pending'
         AND ($3::uuid IS NULL OR a.session_id = $3)
       ORDER BY a.requested_at DESC`,
      [tenantId, userId, sessionId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      risk: row.risk,
      sessionId: row.session_id,
      details: row.details,
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
    dsh_session_id: string | null;
    role_view: string;
    status: string;
  }): SessionRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      runtimeSessionId: row.runtime_session_id,
      ...(row.dsh_session_id ? { dshSessionId: row.dsh_session_id } : {}),
      roleView: row.role_view,
      status: row.status,
    };
  }
}
