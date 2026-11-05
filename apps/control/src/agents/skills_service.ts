import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AgentCommandService } from './commands.js';

export interface AgentSkillRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly source: 'builtin' | 'custom';
  readonly checksum: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly assignments: Array<{ scope: string; targetId: string | null; targetName?: string }>;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  content: string;
  source: 'builtin' | 'custom';
  checksum: string;
  version: number;
  updated_at: Date;
}

export interface BuiltinSkillPayload {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly content?: unknown;
  readonly checksum?: unknown;
}

export class AgentSkillService {
  constructor(
    private readonly pool: Pool,
    private readonly commands = new AgentCommandService(pool),
  ) {}

  async list(tenantId: string): Promise<AgentSkillRecord[]> {
    const result = await this.pool.query<SkillRow>(
      `SELECT id, name, description, content, source, checksum, version, updated_at
       FROM agent_skills WHERE tenant_id = $1 ORDER BY source DESC, name`,
      [tenantId],
    );
    const assignments = await this.pool.query<{
      skill_id: string; scope: string; target_id: string | null; target_name: string | null;
    }>(
      `SELECT a.skill_id, a.scope, a.target_id,
              COALESCE(g.hostname, s.name) AS target_name
       FROM agent_skill_assignments a
       LEFT JOIN agents g ON g.id = a.target_id AND a.scope = 'agent'
       LEFT JOIN app_systems s ON s.id = a.target_id AND a.scope = 'app_system'
       WHERE a.tenant_id = $1 ORDER BY a.created_at`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      content: row.content,
      source: row.source,
      checksum: row.checksum,
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
      assignments: assignments.rows
        .filter((item) => item.skill_id === row.id)
        .map((item) => ({ scope: item.scope, targetId: item.target_id, ...(item.target_name ? { targetName: item.target_name } : {}) })),
    }));
  }

  async syncBuiltin(tenantId: string, skills: BuiltinSkillPayload[]): Promise<number> {
    let changed = 0;
    for (const skill of skills.slice(0, 100)) {
      if (typeof skill.name !== 'string' || !skill.name.trim()) continue;
      const name = skill.name.trim();
      const description = typeof skill.description === 'string' ? skill.description : '';
      const content = typeof skill.content === 'string' ? skill.content : '';
      const checksum = typeof skill.checksum === 'string' && skill.checksum
        ? skill.checksum
        : createHash('sha256').update(content).digest('hex');
      const result = await this.pool.query(
        `INSERT INTO agent_skills (tenant_id, name, description, content, source, checksum)
         VALUES ($1, $2, $3, $4, 'builtin', $5)
         ON CONFLICT (tenant_id, name) DO UPDATE
         SET description = EXCLUDED.description, content = EXCLUDED.content,
             checksum = EXCLUDED.checksum, version = agent_skills.version + 1, updated_at = now()
         WHERE agent_skills.source = 'builtin' AND agent_skills.checksum <> EXCLUDED.checksum
         RETURNING id`,
        [tenantId, name, description, content, checksum],
      );
      if (result.rows[0]) changed += 1;
    }
    return changed;
  }

  async createCustom(tenantId: string, input: {
    name: string; description: string; content: string;
  }): Promise<AgentSkillRecord | null> {
    const checksum = createHash('sha256').update(input.content).digest('hex');
    const result = await this.pool.query<SkillRow>(
      `INSERT INTO agent_skills (tenant_id, name, description, content, source, checksum)
       VALUES ($1, $2, $3, $4, 'custom', $5)
       ON CONFLICT (tenant_id, name) DO UPDATE
       SET description = EXCLUDED.description, content = EXCLUDED.content,
           checksum = EXCLUDED.checksum, version = agent_skills.version + 1, updated_at = now()
       WHERE agent_skills.source = 'custom'
       RETURNING id, name, description, content, source, checksum, version, updated_at`,
      [tenantId, input.name, input.description, input.content, checksum],
    );
    const row = result.rows[0];
    return row ? { ...this.map(row), assignments: [] } : null;
  }

  async deleteCustom(tenantId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM agent_skills WHERE tenant_id = $1 AND id = $2 AND source = 'custom'`,
      [tenantId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async assign(tenantId: string, skillId: string, scope: 'all' | 'app_system' | 'agent', targetId?: string): Promise<{ synced: number; agents: string[] } | null> {
    const skill = await this.pool.query<SkillRow>(
      `SELECT id, name, description, content, source, checksum, version, updated_at
       FROM agent_skills WHERE tenant_id = $1 AND id = $2`,
      [tenantId, skillId],
    );
    const row = skill.rows[0];
    if (!row) return null;

    let agentRows: Array<{ id: string; hostname: string }>;
    if (scope === 'agent' && targetId) {
      agentRows = (await this.pool.query<{ id: string; hostname: string }>(
        'SELECT id, hostname FROM agents WHERE tenant_id = $1 AND id = $2 AND status = $3',
        [tenantId, targetId, 'online'],
      )).rows;
    } else if (scope === 'app_system' && targetId) {
      agentRows = (await this.pool.query<{ id: string; hostname: string }>(
        'SELECT id, hostname FROM agents WHERE tenant_id = $1 AND app_system_id = $2 AND status = $3',
        [tenantId, targetId, 'online'],
      )).rows;
    } else {
      agentRows = (await this.pool.query<{ id: string; hostname: string }>(
        'SELECT id, hostname FROM agents WHERE tenant_id = $1 AND status = $2',
        [tenantId, 'online'],
      )).rows;
    }
    if (agentRows.length === 0) return { synced: 0, agents: [] };

    await this.pool.query(
      `INSERT INTO agent_skill_assignments (tenant_id, skill_id, scope, target_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, skill_id, scope, target_id) DO UPDATE SET updated_at = now()`,
      [tenantId, skillId, scope, targetId ?? null],
    );
    for (const agent of agentRows) {
      await this.commands.create({
        tenantId,
        agentId: agent.id,
        type: 'skill_sync',
        input: {
          skills: [{
            name: row.name,
            description: row.description,
            content: row.content,
            source: row.source,
            checksum: row.checksum,
          }],
        },
      });
    }
    return { synced: agentRows.length, agents: agentRows.map((agent) => agent.hostname) };
  }

  private map(row: SkillRow): Omit<AgentSkillRecord, 'assignments'> {
    return {
      id: row.id, name: row.name, description: row.description, content: row.content,
      source: row.source, checksum: row.checksum, version: row.version,
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
