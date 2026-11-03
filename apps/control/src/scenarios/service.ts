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
}

export interface ToolResolver {
  resolve(name: string): ConnectorTool | undefined;
}

export interface ScenarioRunResult {
  readonly status: 'success' | 'failed';
  readonly results: readonly unknown[];
  readonly error?: string;
}

export class ScenarioService {
  constructor(
    private readonly pool: Pool,
    private readonly tools: ToolResolver,
  ) {}

  async list(tenantId: string): Promise<ScenarioRecord[]> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, name, description, definition, status, version
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
       RETURNING id, tenant_id, name, description, definition, status, version`,
      [input.tenantId, input.name, input.description ?? null, JSON.stringify(input.definition)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('scenario_insert_failed');
    return this.map(row);
  }

  async get(tenantId: string, id: string): Promise<ScenarioRecord | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, name, description, definition, status, version
       FROM scenarios WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = result.rows[0];
    return row ? this.map(row) : null;
  }

  async run(tenantId: string, id: string): Promise<ScenarioRunResult | null> {
    const scenario = await this.get(tenantId, id);
    if (!scenario) return null;

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

  private map(row: {
    id: string;
    tenant_id: string;
    name: string;
    description: string | null;
    definition: ScenarioDefinition;
    status: string;
    version: number;
  }): ScenarioRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      description: row.description,
      definition: row.definition,
      status: row.status,
      version: row.version,
    };
  }
}
