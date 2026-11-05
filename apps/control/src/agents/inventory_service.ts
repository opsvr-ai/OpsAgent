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
    const scope = await this.scope(tenantId, agentId);
    const hides = await this.pool.query<{ kind: string; name: string }>(
      `SELECT kind, name FROM agent_inventory_hides
       WHERE tenant_id = $1 AND (($2::uuid IS NOT NULL AND app_system_id = $2) OR agent_id = $3)`,
      [tenantId, scope.appSystemId, agentId],
    );
    const hidden = new Set(hides.rows.map((row) => `${row.kind}:${row.name}`));
    const overrides = await this.pool.query<{
      kind: string; name: string; target_kind: string | null; important: boolean | null; monitored: boolean | null;
    }>(
      `SELECT kind, name, target_kind, important, monitored FROM agent_inventory_overrides
       WHERE tenant_id = $1 AND (($2::uuid IS NOT NULL AND app_system_id = $2) OR agent_id = $3)`,
      [tenantId, scope.appSystemId, agentId],
    );
    const overrideMap = new Map(overrides.rows.map((row) => [`${row.kind}:${row.name}`, row]));
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
    for (const item of items.slice(0, 2000)) {
      if (hidden.has(`${item.kind}:${item.name}`)) continue;
      const override = overrideMap.get(`${item.kind}:${item.name}`);
      const targetKind = (override?.target_kind as InventoryKind | undefined) ?? item.kind;
      unique.set(`${targetKind}:${item.name}`, { ...item, kind: targetKind });
    }
    for (const item of unique.values()) {
      const override = overrideMap.get(`${item.kind}:${item.name}`) ?? overrideMap.get(`process:${item.name}`) ?? overrideMap.get(`port:${item.name}`) ?? overrideMap.get(`service:${item.name}`);
      await this.pool.query(
        `INSERT INTO agent_inventory (tenant_id, agent_id, kind, name, detail, important, monitored)
         VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, false), COALESCE($7, false))
         ON CONFLICT (tenant_id, agent_id, kind, name)
         DO UPDATE SET detail = EXCLUDED.detail,
           important = CASE WHEN $6::boolean IS NULL THEN agent_inventory.important ELSE $6 END,
           monitored = CASE WHEN $7::boolean IS NULL THEN agent_inventory.monitored ELSE $7 END,
           updated_at = now()`,
        [tenantId, agentId, item.kind, item.name, JSON.stringify(item.detail), override?.important ?? null, override?.monitored ?? null],
      );
      if (overrideMap.has(`process:${item.name}`) && overrideMap.get(`process:${item.name}`)?.target_kind === 'ops_tool') {
        await this.pool.query(
          `DELETE FROM agent_inventory WHERE tenant_id = $1 AND agent_id = $2 AND kind = 'process' AND name = $3`,
          [tenantId, agentId, item.name],
        );
      }
    }
    const processNames = [...unique.values()].filter((item) => item.kind === 'process').map((item) => item.name);
    if (processNames.length > 0) {
      await this.pool.query(
        `DELETE FROM agent_inventory
         WHERE tenant_id = $1 AND agent_id = $2 AND kind = 'process'
           AND NOT important AND name <> ALL($3::text[])`,
        [tenantId, agentId, processNames],
      );
    }
    return unique.size;
  }

  private async scope(tenantId: string, agentId: string): Promise<{ appSystemId: string | null }> {
    const result = await this.pool.query<{ app_system_id: string | null }>(
      'SELECT app_system_id FROM agents WHERE tenant_id = $1 AND id = $2',
      [tenantId, agentId],
    );
    return { appSystemId: result.rows[0]?.app_system_id ?? null };
  }

  private async scopedAgentIds(tenantId: string, agentId: string): Promise<{ appSystemId: string | null; ids: string[] }> {
    const scope = await this.scope(tenantId, agentId);
    if (!scope.appSystemId) return { appSystemId: null, ids: [agentId] };
    const agents = await this.pool.query<{ id: string }>(
      'SELECT id FROM agents WHERE tenant_id = $1 AND app_system_id = $2',
      [tenantId, scope.appSystemId],
    );
    return { appSystemId: scope.appSystemId, ids: agents.rows.map((row) => row.id) };
  }

  async hide(tenantId: string, agentId: string, itemId: string, userId: string): Promise<boolean> {
    const item = await this.pool.query<{ kind: string; name: string }>(
      'SELECT kind, name FROM agent_inventory WHERE tenant_id = $1 AND agent_id = $2 AND id = $3',
      [tenantId, agentId, itemId],
    );
    const row = item.rows[0];
    if (!row) return false;
    const scope = await this.scopedAgentIds(tenantId, agentId);
    await this.pool.query(
      `INSERT INTO agent_inventory_hides (tenant_id, app_system_id, agent_id, kind, name, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        scope.appSystemId,
        scope.appSystemId ? null : agentId,
        row.kind,
        row.name,
        userId,
      ],
    );
    await this.pool.query(
      `DELETE FROM agent_inventory
       WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[]) AND kind = $3 AND name = $4`,
      [tenantId, scope.ids, row.kind, row.name],
    );
    return true;
  }

  async promote(tenantId: string, agentId: string, itemId: string, targetKind: 'ops_tool'): Promise<number> {
    const item = await this.pool.query<{
      kind: string; name: string; detail: Record<string, unknown>; important: boolean; monitored: boolean;
    }>(
      'SELECT kind, name, detail, important, monitored FROM agent_inventory WHERE tenant_id = $1 AND agent_id = $2 AND id = $3',
      [tenantId, agentId, itemId],
    );
    const row = item.rows[0];
    if (!row) return 0;
    const scope = await this.scopedAgentIds(tenantId, agentId);
    await this.pool.query(
      `INSERT INTO agent_inventory_overrides
         (tenant_id, app_system_id, agent_id, kind, name, target_kind, important, monitored)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        scope.appSystemId,
        scope.appSystemId ? null : agentId,
        row.kind,
        row.name,
        targetKind,
        row.important,
        row.monitored,
      ],
    );
    await this.pool.query(
      `INSERT INTO agent_inventory (tenant_id, agent_id, kind, name, detail, important, monitored)
       SELECT tenant_id, agent_id, $1, name, detail, important, monitored
       FROM agent_inventory
       WHERE tenant_id = $2 AND agent_id = ANY($3::uuid[]) AND kind = $4 AND name = $5
       ON CONFLICT (tenant_id, agent_id, kind, name)
       DO UPDATE SET detail = EXCLUDED.detail, important = EXCLUDED.important, monitored = EXCLUDED.monitored`,
      [targetKind, tenantId, scope.ids, row.kind, row.name],
    );
    await this.pool.query(
      `DELETE FROM agent_inventory
       WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[]) AND kind = $3 AND name = $4`,
      [tenantId, scope.ids, row.kind, row.name],
    );
    return scope.ids.length;
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
