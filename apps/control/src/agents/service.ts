import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface AgentRecord {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly os: string;
  readonly arch: string;
  readonly version: string;
  readonly status: string;
  readonly lastSeen: string;
  readonly metrics: Readonly<Record<string, unknown>>;
}

export class AgentService {
  constructor(private readonly pool: Pool) {}

  async register(input: {
    tenantId: string;
    name: string;
    hostname: string;
    os: string;
    arch: string;
    version: string;
    capabilities: readonly string[];
  }): Promise<{ agent: AgentRecord; agentKey: string }> {
    const agentKey = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO agents
         (tenant_id, name, hostname, os, arch, version, status, capabilities, agent_key, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, 'online', $7::jsonb, $8, now())
       ON CONFLICT (tenant_id, hostname) DO UPDATE SET
         name = EXCLUDED.name,
         os = EXCLUDED.os,
         arch = EXCLUDED.arch,
         version = EXCLUDED.version,
         status = 'online',
         capabilities = EXCLUDED.capabilities,
         agent_key = EXCLUDED.agent_key,
         last_seen = now()
       RETURNING id, name, hostname, os, arch, version, status, last_seen, metrics, agent_key`,
      [
        input.tenantId,
        input.name,
        input.hostname,
        input.os,
        input.arch,
        input.version,
        JSON.stringify(input.capabilities),
        agentKey,
      ],
    );
    const row = result.rows[0];
    return { agent: this.map(row), agentKey: row.agent_key as string };
  }

  async heartbeat(
    id: string,
    key: string,
    metrics?: Readonly<Record<string, unknown>>,
  ): Promise<AgentRecord | null> {
    const result = await this.pool.query(
      `UPDATE agents
       SET last_seen = now(), status = 'online', metrics = COALESCE($3::jsonb, metrics)
       WHERE id = $1 AND agent_key = $2
       RETURNING id, name, hostname, os, arch, version, status, last_seen, metrics`,
      [id, key, metrics ? JSON.stringify(metrics) : null],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async list(tenantId: string): Promise<AgentRecord[]> {
    const result = await this.pool.query(
      `SELECT id, name, hostname, os, arch, version,
              CASE WHEN last_seen < now() - interval '90 seconds' THEN 'offline' ELSE status END AS status,
              last_seen, metrics
       FROM agents WHERE tenant_id = $1 ORDER BY last_seen DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  private map(row: {
    id: string;
    name: string;
    hostname: string;
    os: string;
    arch: string;
    version: string;
    status: string;
    last_seen: Date;
    metrics: Record<string, unknown> | null;
  }): AgentRecord {
    return {
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      os: row.os,
      arch: row.arch,
      version: row.version,
      status: row.status,
      lastSeen: row.last_seen.toISOString(),
      metrics: row.metrics ?? {},
    };
  }
}
