import type { Pool } from 'pg';

export interface AuditRecord {
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly resource: string | null;
  readonly result: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export class AuditService {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string, limit: number): Promise<AuditRecord[]> {
    const result = await this.pool.query(
      `SELECT id, actor_id, action, resource, result, metadata, created_at
       FROM audit_events
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actor_id,
      resource: row.resource,
      result: row.result,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
