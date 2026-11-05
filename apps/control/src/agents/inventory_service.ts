import type { Pool } from 'pg';

type InventoryKind = 'service' | 'process' | 'port' | 'ops_tool';

export interface InventoryItem {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly important: boolean;
  readonly monitored: boolean;
  readonly appSystemId: string | null;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class AgentInventoryService {
  constructor(private readonly pool: Pool) {}

  async sync(tenantId: string, agentId: string, operations: unknown): Promise<number> {
    const payload = asObject(operations);
    const items: Array<{ kind: InventoryKind; name: string; detail: Record<string, unknown> }> = [];
    for (const service of Array.isArray(payload.services) ? payload.services : []) {
      const entry = asObject(service);
      if (typeof entry.name === 'string' && entry.name) items.push({ kind: 'service', name: entry.name, detail: entry });
    }
    for (const process of Array.isArray(payload.processes) ? payload.processes : []) {
      const entry = asObject(process);
      const name = typeof entry.name === 'string' ? entry.name : '';
      if (name) items.push({ kind: 'process', name, detail: entry });
    }
    for (const port of Array.isArray(payload.ports) ? payload.ports : []) {
      const entry = asObject(port);
      if (typeof entry.address === 'string' && entry.address) {
        items.push({ kind: 'port', name: entry.address, detail: entry });
      }
    }
    for (const tool of Array.isArray(payload.opsTools) ? payload.opsTools : []) {
      const entry = asObject(tool);
      if (typeof entry.name === 'string' && entry.name) items.push({ kind: 'ops_tool', name: entry.name, detail: entry });
    }
    const unique = new Map<string, { kind: InventoryKind; name: string; detail: Record<string, unknown> }>();
    for (const item of items.slice(0, 200)) unique.set(`${item.kind}:${item.name}`, item);
    for (const item of unique.values()) {
      await this.pool.query(
        `INSERT INTO agent_inventory (tenant_id, agent_id, kind, name, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (tenant_id, agent_id, kind, name)
         DO UPDATE SET detail = EXCLUDED.detail, updated_at = now()`,
        [tenantId, agentId, item.kind, item.name, JSON.stringify(item.detail)],
      );
    }
    return unique.size;
  }

  async list(tenantId: string, agentId: string): Promise<InventoryItem[]> {
    const result = await this.pool.query<{
      id: string; kind: string; name: string; detail: Record<string, unknown>;
      important: boolean; monitored: boolean; app_system_id: string | null;
    }>(
      `SELECT id, kind, name, detail, important, monitored, app_system_id
       FROM agent_inventory WHERE tenant_id = $1 AND agent_id = $2
       ORDER BY important DESC, monitored DESC, kind, name`,
      [tenantId, agentId],
    );
    return result.rows.map((row) => ({
      id: row.id, kind: row.kind, name: row.name, detail: row.detail,
      important: row.important, monitored: row.monitored, appSystemId: row.app_system_id,
    }));
  }

  async update(tenantId: string, id: string, input: {
    important?: boolean; monitored?: boolean; appSystemId?: string | null;
  }): Promise<InventoryItem | null> {
    const result = await this.pool.query<{
      id: string; kind: string; name: string; detail: Record<string, unknown>;
      important: boolean; monitored: boolean; app_system_id: string | null;
    }>(
      `UPDATE agent_inventory
       SET important = COALESCE($3, important),
           monitored = COALESCE($4, monitored),
           app_system_id = CASE WHEN $5::uuid IS NULL THEN app_system_id ELSE $5::uuid END,
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, kind, name, detail, important, monitored, app_system_id`,
      [tenantId, id, input.important ?? null, input.monitored ?? null, input.appSystemId ?? null],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id, kind: row.kind, name: row.name, detail: row.detail,
      important: row.important, monitored: row.monitored, appSystemId: row.app_system_id,
    } : null;
  }

  async watchlist(tenantId: string, agentId: string): Promise<{
    processes: string[]; ports: string[]; services: string[];
  }> {
    const result = await this.pool.query<{ kind: string; name: string }>(
      `SELECT kind, name FROM agent_inventory
       WHERE tenant_id = $1 AND agent_id = $2 AND monitored AND important`,
      [tenantId, agentId],
    );
    return {
      processes: result.rows.filter((row) => row.kind === 'process').map((row) => row.name),
      ports: result.rows.filter((row) => row.kind === 'port').map((row) => row.name.split(':').pop() ?? ''),
      services: result.rows.filter((row) => row.kind === 'service').map((row) => row.name),
    };
  }
}
