import type { Pool } from 'pg';

export interface ScenarioShareRecord {
  readonly id: string;
  readonly scenarioId: string;
  readonly scope: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly reviewerId: string | null;
  readonly reason: string | null;
}

export class ScenarioShareService {
  constructor(private readonly pool: Pool) {}

  async request(input: {
    tenantId: string;
    scenarioId: string;
    requestedBy: string;
    scope: 'tenant' | 'platform';
  }): Promise<ScenarioShareRecord> {
    const result = await this.pool.query(
      `INSERT INTO scenario_shares (tenant_id, scenario_id, requested_by, scope)
       VALUES ($1, $2, $3, $4)
       RETURNING id, scenario_id, scope, status, requested_by, reviewer_id, reason`,
      [input.tenantId, input.scenarioId, input.requestedBy, input.scope],
    );
    return this.map(result.rows[0]);
  }

  async list(tenantId: string): Promise<ScenarioShareRecord[]> {
    const result = await this.pool.query(
      `SELECT id, scenario_id, scope, status, requested_by, reviewer_id, reason
       FROM scenario_shares WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async review(input: {
    tenantId: string;
    shareId: string;
    reviewerId: string;
    decision: 'approve' | 'reject';
    reason?: string;
  }): Promise<ScenarioShareRecord | null> {
    const result = await this.pool.query(
      `UPDATE scenario_shares
       SET status = $1, reviewer_id = $2, reason = $3, reviewed_at = now()
       WHERE tenant_id = $4 AND id = $5 AND status = 'pending'
       RETURNING id, scenario_id, scope, status, requested_by, reviewer_id, reason`,
      [input.decision === 'approve' ? 'approved' : 'rejected', input.reviewerId, input.reason ?? null, input.tenantId, input.shareId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.status === 'approved' && row.scope === 'tenant') {
      await this.pool.query(
        `UPDATE scenarios SET status = 'published', updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, row.scenario_id],
      );
    }
    return this.map(row);
  }

  private map(row: {
    id: string;
    scenario_id: string;
    scope: string;
    status: string;
    requested_by: string;
    reviewer_id: string | null;
    reason: string | null;
  }): ScenarioShareRecord {
    return {
      id: row.id,
      scenarioId: row.scenario_id,
      scope: row.scope,
      status: row.status,
      requestedBy: row.requested_by,
      reviewerId: row.reviewer_id,
      reason: row.reason,
    };
  }
}
