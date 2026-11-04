import type { Pool } from 'pg';

export interface AgentEventRecord {
  readonly id: string;
  readonly agentId: string;
  readonly fingerprint: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly detail: string;
  readonly metric: Readonly<Record<string, unknown>>;
  readonly details: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly detectedAt: string;
  readonly resolvedAt: string | null;
}

export interface AgentEventInput {
  readonly fingerprint?: unknown;
  readonly severity?: unknown;
  readonly title?: unknown;
  readonly detail?: unknown;
  readonly metric?: unknown;
  readonly resolved?: unknown;
  readonly detectedAt?: unknown;
}

export class AgentEventService {
  constructor(private readonly pool: Pool) {}

  async report(
    agentId: string,
    key: string,
    events: AgentEventInput[],
    resolveMissing = false,
    diagnostics: Readonly<Record<string, unknown>> = {},
  ): Promise<AgentEventRecord[] | null> {
    const agent = await this.pool.query<{ tenant_id: string; hostname: string }>(
      'SELECT tenant_id, hostname FROM agents WHERE id = $1 AND agent_key = $2',
      [agentId, key],
    );
    const row = agent.rows[0];
    if (!row) return null;
    const reportedFingerprints: string[] = [];
    for (const event of events) {
      const fingerprint = typeof event.fingerprint === 'string' ? event.fingerprint : '';
      if (!fingerprint) continue;
      if (event.resolved === true) {
        await this.pool.query(
          `UPDATE agent_events SET status = 'resolved', resolved_at = now()
           WHERE agent_id = $1 AND fingerprint = $2 AND status = 'open'`,
          [agentId, fingerprint],
        );
        continue;
      }
      reportedFingerprints.push(fingerprint);
      const severity = event.severity === 'critical' || event.severity === 'info' ? event.severity : 'warning';
      const title = typeof event.title === 'string' ? event.title : `${row.hostname} 异常`;
      const detail = typeof event.detail === 'string' ? event.detail : '';
      const metric = typeof event.metric === 'object' && event.metric !== null && !Array.isArray(event.metric)
        ? event.metric as Record<string, unknown>
        : {};
      const existing = await this.pool.query<{ id: string }>(
        `SELECT id FROM agent_events WHERE agent_id = $1 AND fingerprint = $2 AND status = 'open' LIMIT 1`,
        [agentId, fingerprint],
      );
      if (existing.rows[0]) {
        await this.pool.query(
          `UPDATE agent_events SET severity = $1, title = $2, detail = $3, metric = $4::jsonb,
             details = $5::jsonb, detected_at = now()
           WHERE id = $6`,
          [severity, title, detail, JSON.stringify(metric), JSON.stringify(diagnostics), existing.rows[0].id],
        );
      } else {
        await this.pool.query(
          `INSERT INTO agent_events (tenant_id, agent_id, fingerprint, severity, title, detail, metric, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
          [row.tenant_id, agentId, fingerprint, severity, title, detail, JSON.stringify(metric), JSON.stringify(diagnostics)],
        );
        await this.pool.query(
          `INSERT INTO messages (tenant_id, title, body, severity)
           VALUES ($1, $2, $3, $4)`,
          [row.tenant_id, title, `${row.hostname}: ${detail}`, severity],
        );
      }
    }
    if (resolveMissing) {
      await this.pool.query(
        `UPDATE agent_events SET status = 'resolved', resolved_at = now()
         WHERE agent_id = $1 AND status = 'open' AND fingerprint <> ALL($2::text[])`,
        [agentId, reportedFingerprints],
      );
    }
    return this.list(row.tenant_id, agentId);
  }

  async list(tenantId: string, agentId: string): Promise<AgentEventRecord[]> {
    const result = await this.pool.query<{
      id: string; agent_id: string; fingerprint: string; severity: string; title: string;
      detail: string; metric: Record<string, unknown>; details: Record<string, unknown>; status: string; detected_at: Date; resolved_at: Date | null;
    }>(
      `SELECT id, agent_id, fingerprint, severity, title, detail, metric, details, status, detected_at, resolved_at
       FROM agent_events WHERE tenant_id = $1 AND agent_id = $2
       ORDER BY status = 'open' DESC, detected_at DESC LIMIT 100`,
      [tenantId, agentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      fingerprint: row.fingerprint,
      severity: row.severity as AgentEventRecord['severity'],
      title: row.title,
      detail: row.detail,
      metric: row.metric,
      details: row.details,
      status: row.status,
      detectedAt: row.detected_at.toISOString(),
      resolvedAt: row.resolved_at?.toISOString() ?? null,
    }));
  }

  async openForTenant(tenantId: string): Promise<Array<AgentEventRecord & { hostname: string }>> {
    const result = await this.pool.query<{
      id: string; agent_id: string; hostname: string; fingerprint: string; severity: string;
      title: string; detail: string; metric: Record<string, unknown>; details: Record<string, unknown>; status: string;
      detected_at: Date; resolved_at: Date | null;
    }>(
      `SELECT e.id, e.agent_id, a.hostname, e.fingerprint, e.severity, e.title, e.detail,
              e.metric, e.details, e.status, e.detected_at, e.resolved_at
       FROM agent_events e JOIN agents a ON a.id = e.agent_id
       WHERE e.tenant_id = $1 AND e.status = 'open'
       ORDER BY CASE e.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.detected_at DESC
       LIMIT 100`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      hostname: row.hostname,
      fingerprint: row.fingerprint,
      severity: row.severity as AgentEventRecord['severity'],
      title: row.title,
      detail: row.detail,
      metric: row.metric,
      details: row.details,
      status: row.status,
      detectedAt: row.detected_at.toISOString(),
      resolvedAt: row.resolved_at?.toISOString() ?? null,
    }));
  }
}
