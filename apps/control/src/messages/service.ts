import type { Pool } from 'pg';

export interface MessageRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export class MessageService {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string, userId: string): Promise<MessageRecord[]> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      body: string;
      severity: string;
      read_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, title, body, severity, read_at, created_at
       FROM messages
       WHERE tenant_id = $1 AND (user_id = $2 OR user_id IS NULL)
       ORDER BY created_at DESC LIMIT 100`,
      [tenantId, userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      severity: row.severity,
      readAt: row.read_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async markRead(tenantId: string, userId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE messages SET read_at = now()
       WHERE tenant_id = $1 AND id = $2 AND (user_id = $3 OR user_id IS NULL)`,
      [tenantId, id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
