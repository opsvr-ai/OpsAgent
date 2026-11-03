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

  async exportCsv(tenantId: string, limit = 1000): Promise<string> {    const records = await this.list(tenantId, limit);
    const escape = (value: unknown): string => {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
      return `"${text.replaceAll('"', '""')}"`;
    };
    const header = ['createdAt', 'action', 'result', 'actorId', 'resource', 'metadata'].join(',');
    const rows = records.map((record) =>
      [
        record.createdAt,
        record.action,
        record.result,
        record.actorId ?? '',
        record.resource ?? '',
        record.metadata,
      ]
        .map(escape)
        .join(','),
    );
    return [header, ...rows].join('\n');
  }

  async purgeOlderThan(days: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM audit_events WHERE created_at < now() - ($1 || ' days')::interval`,
      [Math.max(1, Math.trunc(days))],
    );
    return result.rowCount ?? 0;
  }
}
