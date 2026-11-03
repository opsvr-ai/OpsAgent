import type { Pool } from 'pg';

export interface AgentCommandRecord {
  readonly id: string;
  readonly agentId: string;
  readonly type: string;
  readonly status: string;
  readonly result: unknown;
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
       RETURNING id, agent_id, type, status, result`,
      [input.tenantId, input.agentId, input.type],
    );
    return this.map(result.rows[0]);
  }

  async list(tenantId: string, agentId: string): Promise<AgentCommandRecord[]> {
    const result = await this.pool.query(
      `SELECT id, agent_id, type, status, result FROM agent_commands
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
       RETURNING id, agent_id, type, status, result`,
      [agentId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async complete(input: {
    agentId: string;
    commandId: string;
    key: string;
    result: unknown;
  }): Promise<AgentCommandRecord | null> {
    const agent = await this.pool.query(
      'SELECT 1 FROM agents WHERE id = $1 AND agent_key = $2',
      [input.agentId, input.key],
    );
    if (agent.rowCount === 0) return null;
    const result = await this.pool.query(
      `UPDATE agent_commands
       SET status = 'completed', result = $1::jsonb, completed_at = now()
       WHERE id = $2 AND agent_id = $3
       RETURNING id, agent_id, type, status, result`,
      [JSON.stringify(input.result), input.commandId, input.agentId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  private map(row: {
    id: string;
    agent_id: string;
    type: string;
    status: string;
    result: unknown;
  }): AgentCommandRecord {
    return {
      id: row.id,
      agentId: row.agent_id,
      type: row.type,
      status: row.status,
      result: row.result,
    };
  }
}
