import type { Pool } from 'pg';
import { AgentCommandService, type AgentCommandRecord } from './commands.js';

export type AgentControlTargetMode = 'agent' | 'app_system' | 'all_online';

export interface AgentControlPlan {
  readonly tenantId: string;
  readonly userId: string;
  readonly instruction: string;
  readonly targetMode: AgentControlTargetMode;
  readonly targetId?: string;
  readonly targetName?: string;
}

export interface AgentControlRun {
  readonly hostname: string;
  readonly status: string;
  readonly answer: string;
  readonly analysis: string;
}

export interface AgentControlResult {
  readonly taskId: string;
  readonly status: string;
  readonly instruction: string;
  readonly total: number;
  readonly success: number;
  readonly failed: number;
  readonly runs: AgentControlRun[];
}

interface TargetAgent {
  id: string;
  hostname: string;
}

export class AgentControlService {
  constructor(
    private readonly pool: Pool,
    private readonly commands = new AgentCommandService(pool),
  ) {}

  async resolveTargets(tenantId: string, mode: AgentControlTargetMode, selector?: string): Promise<TargetAgent[]> {
    if (mode === 'all_online') {
      const result = await this.pool.query<TargetAgent>(
        `SELECT id, hostname FROM agents
         WHERE tenant_id = $1 AND status = 'online' ORDER BY hostname LIMIT 20`,
        [tenantId],
      );
      return result.rows;
    }
    if (mode === 'agent') {
      const result = await this.pool.query<TargetAgent>(
        `SELECT id, hostname FROM agents
         WHERE tenant_id = $1 AND status = 'online'
           AND (id::text = $2 OR hostname = $2 OR name = $2)
         LIMIT 1`,
        [tenantId, selector ?? ''],
      );
      return result.rows;
    }
    const system = await this.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM app_systems
       WHERE tenant_id = $1 AND ($2::text IS NULL OR id::text = $2 OR name = $2 OR code = $2)
       ORDER BY name LIMIT 1`,
      [tenantId, selector ?? null],
    );
    const row = system.rows[0];
    if (!row) return [];
    const result = await this.pool.query<TargetAgent>(
      `SELECT id, hostname FROM agents
       WHERE tenant_id = $1 AND app_system_id = $2 AND status = 'online'
       ORDER BY hostname LIMIT 20`,
      [tenantId, row.id],
    );
    return result.rows;
  }

  async createAndRun(plan: AgentControlPlan): Promise<AgentControlResult> {
    const targets = await this.resolveTargets(plan.tenantId, plan.targetMode, plan.targetId);
    const createdBy = plan.userId && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(plan.userId) ? plan.userId : null;
    const task = await this.pool.query<{ id: string }>(
      `INSERT INTO agent_control_tasks
         (tenant_id, instruction, target_mode, target_id, target_name, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        plan.tenantId,
        plan.instruction,
        plan.targetMode,
        plan.targetMode === 'all_online' ? null : plan.targetId ?? null,
        plan.targetName ?? null,
        targets.length > 0 ? 'running' : 'failed',
        createdBy,
      ],
    );
    const taskId = task.rows[0]?.id;
    if (!taskId) throw new Error('control_task_create_failed');

    const runs: AgentControlRun[] = [];
    await Promise.all(targets.map(async (agent) => {
      const run = await this.pool.query<{ id: string }>(
        `INSERT INTO agent_control_runs (task_id, tenant_id, agent_id, hostname, status)
         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
        [taskId, plan.tenantId, agent.id, agent.hostname],
      );
      const runId = run.rows[0]?.id;
      const command = await this.commands.create({
        tenantId: plan.tenantId,
        agentId: agent.id,
        type: 'inspect',
        input: { question: plan.instruction },
      });
      if (!command) {
        if (runId) {
          await this.pool.query(
            `UPDATE agent_control_runs SET status = 'failed', error = 'command_create_failed', completed_at = now() WHERE id = $1`,
            [runId],
          );
        }
        runs.push({ hostname: agent.hostname, status: 'failed', answer: '', analysis: '' });
        return;
      }
      if (runId) {
        await this.pool.query('UPDATE agent_control_runs SET command_id = $1, status = $2 WHERE id = $3', [
          command.id,
          'running',
          runId,
        ]);
      }
      const final = await this.pollCommand(plan.tenantId, agent.id, command.id);
      const payload = typeof final?.result === 'object' && final.result !== null
        ? final.result as Record<string, unknown>
        : {};
      const answer = typeof payload.answer === 'string' ? payload.answer : '';
      const analysis = typeof payload.analysis === 'string' ? payload.analysis : '';
      const status = final?.status === 'completed' ? 'completed' : 'failed';
      if (runId) {
        await this.pool.query(
          `UPDATE agent_control_runs
           SET status = $1, answer = $2, error = $3, completed_at = now()
           WHERE id = $4`,
          [status, answer, typeof payload.error === 'string' ? payload.error : '', runId],
        );
      }
      runs.push({ hostname: agent.hostname, status, answer, analysis });
    }));
    const success = runs.filter((run) => run.status === 'completed').length;
    const failed = runs.length - success;
    const status = runs.length === 0 ? 'failed' : failed === 0 ? 'completed' : success === 0 ? 'failed' : 'partial';
    await this.pool.query(
      `UPDATE agent_control_tasks SET status = $1, completed_at = now() WHERE id = $2`,
      [status, taskId],
    );
    return {
      taskId,
      status,
      instruction: plan.instruction,
      total: runs.length,
      success,
      failed,
      runs,
    };
  }

  private async pollCommand(tenantId: string, agentId: string, commandId: string): Promise<AgentCommandRecord | null> {
    let current = await this.commands.get(tenantId, agentId, commandId);
    for (let attempt = 0; attempt < 25 && current && !['completed', 'failed'].includes(current.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = (await this.commands.get(tenantId, agentId, commandId)) ?? current;
    }
    return current;
  }
}
