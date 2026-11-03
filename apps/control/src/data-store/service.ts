import type { Pool } from 'pg';

export interface DataStoreSnapshot {
  readonly id: string;
  readonly tool: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface DataStoreDataset {
  readonly tool: string;
  readonly count: number;
  readonly bytes: number;
  readonly lastSync: string | null;
}

export interface DataStoreStats {
  readonly count: number;
  readonly bytes: number;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly quotaBytes: number;
  readonly usagePct: number;
  readonly datasets: readonly DataStoreDataset[];
  readonly recent: readonly DataStoreSnapshot[];
}

export class DataStoreService {
  constructor(private readonly pool: Pool) {}

  async stats(tenantId: string): Promise<DataStoreStats> {
    const aggregate = await this.pool.query<{
      count: string;
      bytes: string | null;
      oldest: Date | null;
      newest: Date | null;
    }>(
      `SELECT count(*)::text AS count,
              COALESCE(sum(bytes), 0)::text AS bytes,
              min(created_at) AS oldest,
              max(created_at) AS newest
       FROM data_snapshots WHERE tenant_id = $1`,
      [tenantId],
    );
    const recent = await this.pool.query<{
      id: string;
      tool: string;
      bytes: number;
      created_at: Date;
      expires_at: Date | null;
    }>(
      `SELECT id, tool, bytes, created_at, expires_at FROM data_snapshots
       WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [tenantId],
    );
    const datasets = await this.pool.query<{
      tool: string;
      count: string;
      bytes: string;
      last_sync: Date;
    }>(
      `SELECT tool, count(*)::text AS count, COALESCE(sum(bytes), 0)::text AS bytes,
              max(created_at) AS last_sync
       FROM data_snapshots WHERE tenant_id = $1
       GROUP BY tool ORDER BY max(created_at) DESC`,
      [tenantId],
    );
    const row = aggregate.rows[0];
    const quotaBytes = Number(process.env.OPSAGENT_DATA_QUOTA_BYTES ?? 5 * 1024 * 1024 * 1024);
    const bytes = Number(row?.bytes ?? 0);
    return {
      count: Number(row?.count ?? 0),
      bytes,
      oldest: row?.oldest?.toISOString() ?? null,
      newest: row?.newest?.toISOString() ?? null,
      quotaBytes,
      usagePct: quotaBytes > 0 ? Math.round((bytes / quotaBytes) * 1000) / 10 : 0,
      datasets: datasets.rows.map((item) => ({
        tool: item.tool,
        count: Number(item.count),
        bytes: Number(item.bytes),
        lastSync: item.last_sync.toISOString(),
      })),
      recent: recent.rows.map((item) => ({
        id: item.id,
        tool: item.tool,
        bytes: item.bytes,
        createdAt: item.created_at.toISOString(),
        expiresAt: item.expires_at?.toISOString() ?? null,
      })),
    };
  }

  async cleanup(input: {
    tenantId: string;
    beforeDays: number;
    dryRun: boolean;
  }): Promise<{ count: number; bytes: number; dryRun: boolean }> {
    const aggregate = await this.pool.query<{ count: string; bytes: string }>(
      `SELECT count(*)::text AS count, COALESCE(sum(bytes), 0)::text AS bytes
       FROM data_snapshots
       WHERE tenant_id = $1 AND created_at < now() - ($2 || ' days')::interval`,
      [input.tenantId, Math.max(1, Math.trunc(input.beforeDays))],
    );
    const count = Number(aggregate.rows[0]?.count ?? 0);
    const bytes = Number(aggregate.rows[0]?.bytes ?? 0);
    if (!input.dryRun && count > 0) {
      await this.pool.query(
        `DELETE FROM data_snapshots
         WHERE tenant_id = $1 AND created_at < now() - ($2 || ' days')::interval`,
        [input.tenantId, Math.max(1, Math.trunc(input.beforeDays))],
      );
    }
    return { count, bytes, dryRun: input.dryRun };
  }
}
