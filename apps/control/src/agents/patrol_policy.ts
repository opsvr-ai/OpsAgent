import type { Pool } from 'pg';

export interface PatrolPolicy {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly diskFreePct: number;
  readonly memLoadPct: number;
  readonly load1: number;
  readonly updatedAt: string | null;
}

export const DEFAULT_PATROL_POLICY: Omit<PatrolPolicy, 'agentId' | 'updatedAt'> = {
  enabled: true,
  intervalSeconds: 30,
  diskFreePct: 15,
  memLoadPct: 85,
  load1: 0,
};

export class PatrolPolicyService {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string, agentId: string): Promise<PatrolPolicy | null> {
    const agent = await this.pool.query(
      'SELECT id FROM agents WHERE tenant_id = $1 AND id = $2',
      [tenantId, agentId],
    );
    if (!agent.rows[0]) return null;
    const result = await this.pool.query<{
      enabled: boolean;
      interval_seconds: number;
      disk_free_pct: string;
      mem_load_pct: string;
      load1: string;
      updated_at: Date;
    }>(
      `SELECT enabled, interval_seconds, disk_free_pct, mem_load_pct, load1, updated_at
       FROM agent_patrol_policies WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, agentId],
    );
    const row = result.rows[0];
    if (!row) return { agentId, ...DEFAULT_PATROL_POLICY, updatedAt: null };
    return {
      agentId,
      enabled: row.enabled,
      intervalSeconds: row.interval_seconds,
      diskFreePct: Number(row.disk_free_pct),
      memLoadPct: Number(row.mem_load_pct),
      load1: Number(row.load1),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async upsert(tenantId: string, agentId: string, input: {
    enabled: boolean;
    intervalSeconds: number;
    diskFreePct: number;
    memLoadPct: number;
    load1: number;
  }): Promise<PatrolPolicy | null> {
    const agent = await this.pool.query(
      'SELECT id FROM agents WHERE tenant_id = $1 AND id = $2',
      [tenantId, agentId],
    );
    if (!agent.rows[0]) return null;
    const result = await this.pool.query<{
      enabled: boolean;
      interval_seconds: number;
      disk_free_pct: string;
      mem_load_pct: string;
      load1: string;
      updated_at: Date;
    }>(
      `INSERT INTO agent_patrol_policies
         (tenant_id, agent_id, enabled, interval_seconds, disk_free_pct, mem_load_pct, load1)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, agent_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, interval_seconds = EXCLUDED.interval_seconds,
           disk_free_pct = EXCLUDED.disk_free_pct, mem_load_pct = EXCLUDED.mem_load_pct,
           load1 = EXCLUDED.load1, updated_at = now()
       RETURNING enabled, interval_seconds, disk_free_pct, mem_load_pct, load1, updated_at`,
      [
        tenantId,
        agentId,
        input.enabled,
        Math.min(Math.max(input.intervalSeconds, 30), 3600),
        Math.min(Math.max(input.diskFreePct, 1), 99),
        Math.min(Math.max(input.memLoadPct, 1), 100),
        Math.max(input.load1, 0),
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      agentId,
      enabled: row.enabled,
      intervalSeconds: row.interval_seconds,
      diskFreePct: Number(row.disk_free_pct),
      memLoadPct: Number(row.mem_load_pct),
      load1: Number(row.load1),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
