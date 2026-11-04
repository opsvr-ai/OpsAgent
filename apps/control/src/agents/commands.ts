import type { Pool } from 'pg';

export interface AgentCommandRecord {
  readonly id: string;
  readonly agentId: string;
  readonly type: string;
  readonly status: string;
  readonly result: unknown;
  readonly createdAt: string;
}

export class AgentCommandService {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    tenantId: string;
    agentId: string;
    type: string;
  }): Promise<AgentCommandRecord | null> {
    const agent = await this.pool.query(
      'SELECT 1 FROM agents WHERE tenant_id = $1 AND id = $2',
      [input.tenantId, input.agentId],
    );
    if (agent.rowCount === 0) return null;
    const result = await this.pool.query(
      `INSERT INTO agent_commands (tenant_id, agent_id, type)
       VALUES ($1, $2, $3)
       RETURNING id, agent_id, type, status, result, created_at`,
      [input.tenantId, input.agentId, input.type],
    );
    return this.map(result.rows[0]);
  }

  async list(tenantId: string, agentId: string): Promise<AgentCommandRecord[]> {
    const result = await this.pool.query(
      `SELECT id, agent_id, type, status, result, created_at FROM agent_commands
       WHERE tenant_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [tenantId, agentId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async pending(agentId: string, key: string): Promise<AgentCommandRecord | null> {
    const agent = await this.pool.query(
      'SELECT 1 FROM agents WHERE id = $1 AND agent_key = $2',
      [agentId, key],
    );
    if (agent.rowCount === 0) return null;
    const result = await this.pool.query(
      `UPDATE agent_commands SET status = 'dispatched', dispatched_at = now()
       WHERE id = (
         SELECT id FROM agent_commands
         WHERE agent_id = $1 AND status = 'pending'
         ORDER BY created_at ASC LIMIT 1
       )
       RETURNING id, agent_id, type, status, result, created_at`,
      [agentId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async get(tenantId: string, agentId: string, commandId: string): Promise<AgentCommandRecord | null> {
    const result = await this.pool.query(
      `SELECT id, agent_id, type, status, result, created_at FROM agent_commands
       WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
      [tenantId, agentId, commandId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async complete(input: {
    agentId: string;
    commandId: string;
    key: string;
    result: unknown;
  }): Promise<AgentCommandRecord | null> {
    const agent = await this.pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM agents WHERE id = $1 AND agent_key = $2',
      [input.agentId, input.key],
    );
    if (agent.rowCount === 0) return null;
    const result = await this.pool.query(
      `UPDATE agent_commands
       SET status = 'completed', result = $1::jsonb, completed_at = now()
       WHERE id = $2 AND agent_id = $3
       RETURNING id, agent_id, type, status, result, created_at`,
      [JSON.stringify(input.result), input.commandId, input.agentId],
    );
    const record = result.rows[0];
    if (record && typeof input.result === 'object' && input.result !== null) {
      const discovery = (input.result as Record<string, unknown>).discovery;
      if (typeof discovery === 'object' && discovery !== null && !Array.isArray(discovery)) {
        const report = discovery as Record<string, unknown>;
        const tenantId = agent.rows[0]?.tenant_id;
        if (tenantId) {
          await this.pool.query(
            `UPDATE agents SET
               system_info = COALESCE($3::jsonb, system_info),
               applications = COALESCE($4::jsonb, applications),
               agent_info = COALESCE($5::jsonb, agent_info),
               discovery_at = now()
             WHERE id = $1 AND tenant_id = $2`,
            [
              input.agentId,
              tenantId,
              report.system ? JSON.stringify(report.system) : null,
              report.applications ? JSON.stringify(report.applications) : null,
              report.agent ? JSON.stringify(report.agent) : null,
            ],
          );
        }
      }
    }
    return record ? this.map(record) : null;
  }

  private map(row: {
    id: string;
    agent_id: string;
    type: string;
    status: string;
    result: unknown;
    created_at: string;
  }): AgentCommandRecord {
    return {
      id: row.id,
      agentId: row.agent_id,
      type: row.type,
      status: row.status,
      result: row.result,
      createdAt: row.created_at,
    };
  }
}

