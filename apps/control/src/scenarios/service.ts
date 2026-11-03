import type { Pool } from 'pg';
import type { ConnectorTool } from '../connectors/types.js';

export interface ScenarioStep {
  readonly name: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ScenarioDefinition {
  readonly steps: readonly ScenarioStep[];
}

export interface ScenarioRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly definition: ScenarioDefinition;
  readonly status: string;
  readonly version: number;
  readonly scheduleIntervalMinutes: number | null;
}

export interface ToolResolver {
  resolve(name: string): ConnectorTool | undefined;
}

export interface ScenarioRunResult {
  readonly status: 'success' | 'failed';
  readonly results: readonly unknown[];
  readonly error?: string;
}

export interface ScenarioRunRecord {
  readonly id: string;
  readonly scenarioId: string;
  readonly status: string;
  readonly results: readonly unknown[];
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export class ScenarioService {
  constructor(
    private readonly pool: Pool,
    private readonly tools: ToolResolver,
  ) {}

  async list(tenantId: string): Promise<ScenarioRecord[]> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, name, description, definition, status, version, schedule_interval_minutes
       FROM scenarios WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async create(input: {
    tenantId: string;
    name: string;
    description?: string;
    definition: ScenarioDefinition;
  }): Promise<ScenarioRecord> {
    const result = await this.pool.query(
      `INSERT INTO scenarios (tenant_id, name, description, definition)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, tenant_id, name, description, definition, status, version, schedule_interval_minutes`,
      [input.tenantId, input.name, input.description ?? null, JSON.stringify(input.definition)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('scenario_insert_failed');
    return this.map(row);
  }

  async get(tenantId: string, id: string): Promise<ScenarioRecord | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, name, description, definition, status, version, schedule_interval_minutes
       FROM scenarios WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = result.rows[0];
    return row ? this.map(row) : null;
  }

  async setStatus(tenantId: string, id: string, status: string): Promise<ScenarioRecord | null> {
    const result = await this.pool.query(
      `UPDATE scenarios SET status = $1, updated_at = now()
       WHERE tenant_id = $2 AND id = $3
       RETURNING id, tenant_id, name, description, definition, status, version, schedule_interval_minutes`,
      [status, tenantId, id],
    );
    const row = result.rows[0];
    return row ? this.map(row) : null;
  }

  async setSchedule(tenantId: string, id: string, intervalMinutes: number | null): Promise<void> {
    await this.pool.query(
      `UPDATE scenarios
       SET schedule_interval_minutes = $1, schedule_enabled = $2, updated_at = now()
       WHERE tenant_id = $3 AND id = $4`,
      [intervalMinutes, intervalMinutes !== null, tenantId, id],
    );
  }

  async listDue(now: Date): Promise<ScenarioRecord[]> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, name, description, definition, status, version, schedule_interval_minutes
       FROM scenarios
       WHERE schedule_enabled = true
         AND schedule_interval_minutes IS NOT NULL
         AND (last_run_at IS NULL OR last_run_at <= $1::timestamptz - (schedule_interval_minutes || ' minutes')::interval)
       ORDER BY created_at ASC`,
      [now.toISOString()],
    );
    return result.rows.map((row) => this.map(row));
  }

  async run(tenantId: string, id: string): Promise<ScenarioRunResult | null> {
    const scenario = await this.get(tenantId, id);
    if (!scenario) return null;
    await this.pool.query('UPDATE scenarios SET last_run_at = now() WHERE id = $1', [id]);

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO scenario_runs (tenant_id, scenario_id, status)
       VALUES ($1, $2, 'running') RETURNING id`,
      [tenantId, id],
    );
    const runId = inserted.rows[0]?.id;
    if (!runId) throw new Error('scenario_run_insert_failed');

    const results: unknown[] = [];
    try {
      for (const step of scenario.definition.steps) {
        const tool = this.tools.resolve(step.tool);
        if (!tool) throw new Error(`tool_not_found: ${step.tool}`);
        results.push(await tool.execute(step.input, { tenantId }));
      }
      await this.finishRun(runId, 'success', results, null);
      return { status: 'success', results };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'scenario_failed';
      await this.finishRun(runId, 'failed', results, message);
      return { status: 'failed', results, error: message };
    }
  }

  async listRuns(tenantId: string, scenarioId: string): Promise<ScenarioRunRecord[]> {
    const result = await this.pool.query(
      `SELECT id, scenario_id, status, result, error, started_at, finished_at
       FROM scenario_runs
       WHERE tenant_id = $1 AND scenario_id = $2
       ORDER BY started_at DESC`,
      [tenantId, scenarioId],
    );
    return result.rows.map((row) => this.mapRun(row));
  }

  async getRun(tenantId: string, runId: string): Promise<ScenarioRunRecord | null> {
    const result = await this.pool.query(
      `SELECT id, scenario_id, status, result, error, started_at, finished_at
       FROM scenario_runs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId],
    );
    const row = result.rows[0];
    return row ? this.mapRun(row) : null;
  }

  private async finishRun(
    runId: string,
    status: string,
    results: unknown[],
    error: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE scenario_runs
       SET status = $1, result = $2::jsonb, error = $3, finished_at = now()
       WHERE id = $4`,
      [status, JSON.stringify(results), error, runId],
    );
  }

  private mapRun(row: {
    id: string;
    scenario_id: string;
    status: string;
    result: unknown[] | null;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
  }): ScenarioRunRecord {
    return {
      id: row.id,
      scenarioId: row.scenario_id,
      status: row.status,
      results: row.result ?? [],
      error: row.error,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
    };
  }

  private map(row: {
    id: string;
    tenant_id: string;
    name: string;
    description: string | null;
    definition: ScenarioDefinition;
    status: string;
    version: number;
    schedule_interval_minutes: number | null;
  }): ScenarioRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      description: row.description,
      definition: row.definition,
      status: row.status,
      version: row.version,
      scheduleIntervalMinutes: row.schedule_interval_minutes,
    };
  }
}
