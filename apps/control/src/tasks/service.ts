import type { Pool } from 'pg';
import type { ScenarioService } from '../scenarios/service.js';

export interface LongTaskRecord {
  readonly id: string;
  readonly title: string;
  readonly scenarioId: string;
  readonly status: string;
  readonly runId: string | null;
  readonly error: string | null;
}

export class LongTaskService {
  constructor(
    private readonly pool: Pool,
    private readonly scenarios: ScenarioService,
  ) {}

  async create(input: {
    tenantId: string;
    actorId: string;
    title: string;
    scenarioId: string;
  }): Promise<LongTaskRecord> {
    const result = await this.pool.query(
      `INSERT INTO long_tasks (tenant_id, title, scenario_id, status, created_by)
       VALUES ($1, $2, $3, 'queued', $4)
       RETURNING id, title, scenario_id, status, run_id, error`,
      [input.tenantId, input.title, input.scenarioId, input.actorId],
    );
    const task = this.map(result.rows[0]);
    void this.execute(task.id, input.tenantId, input.scenarioId);
    return task;
  }

  async list(tenantId: string): Promise<LongTaskRecord[]> {
    const result = await this.pool.query(
      `SELECT id, title, scenario_id, status, run_id, error FROM long_tasks
       WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async approve(input: {
    tenantId: string;
    taskId: string;
    userId: string;
    decision: 'approve' | 'reject';
  }): Promise<LongTaskRecord | null> {
    const result = await this.pool.query<{
      id: string;
      scenario_id: string;
      run_id: string | null;
      status: string;
    }>(
      `SELECT id, scenario_id, run_id, status FROM long_tasks
       WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'`,
      [input.tenantId, input.taskId],
    );
    const task = result.rows[0];
    if (!task?.run_id) return null;

    const outcome = await this.scenarios.approve({
      tenantId: input.tenantId,
      runId: task.run_id,
      userId: input.userId,
      decision: input.decision,
    });
    await this.update(
      task.id,
      outcome?.status === 'success' ? 'success' : 'failed',
      task.run_id,
      outcome?.error ?? null,
    );
    return this.get(input.tenantId, task.id);
  }

  private async execute(taskId: string, tenantId: string, scenarioId: string): Promise<void> {
    await this.pool.query("UPDATE long_tasks SET status = 'running' WHERE id = $1", [taskId]);
    try {
      const result = await this.scenarios.run(tenantId, scenarioId);
      if (!result) {
        await this.update(taskId, 'failed', null, 'scenario_not_found');
        return;
      }
      if (result.status === 'awaiting_approval') {
        await this.update(taskId, 'awaiting_approval', result.runId, null);
        return;
      }
      await this.update(taskId, result.status === 'success' ? 'success' : 'failed', result.runId, result.error ?? null);
    } catch (error) {
      await this.update(taskId, 'failed', null, error instanceof Error ? error.message : 'task_failed');
    }
  }

  private async update(
    id: string,
    status: string,
    runId: string | null,
    error: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE long_tasks SET status = $1, run_id = $2, error = $3, updated_at = now()
       WHERE id = $4`,
      [status, runId, error, id],
    );
  }

  private async get(tenantId: string, id: string): Promise<LongTaskRecord | null> {
    const result = await this.pool.query(
      `SELECT id, title, scenario_id, status, run_id, error FROM long_tasks
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  private map(row: {
    id: string;
    title: string;
    scenario_id: string;
    status: string;
    run_id: string | null;
    error: string | null;
  }): LongTaskRecord {
    return {
      id: row.id,
      title: row.title,
      scenarioId: row.scenario_id,
      status: row.status,
      runId: row.run_id,
      error: row.error,
    };
  }
}
