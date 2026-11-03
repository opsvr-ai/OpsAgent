import type { Pool } from 'pg';

export interface StudioBundle {
  readonly goal: string;
  readonly files: readonly string[];
  readonly manifest: Readonly<Record<string, unknown>>;
}

export interface StudioGenerator {
  generate(input: { goal: string; platform: string }): Promise<StudioBundle>;
}

export interface StudioSessionRecord {
  readonly id: string;
  readonly goal: string;
  readonly platform: string;
  readonly status: string;
  readonly bundle: StudioBundle | null;
}

export class StudioConflictError extends Error {
  readonly code = 'studio.conflict';
}

export class StudioNotFoundError extends Error {
  readonly code = 'studio.not_found';
}

export class StudioService {
  constructor(
    private readonly pool: Pool,
    private readonly generator?: StudioGenerator,
  ) {}

  async create(input: {
    tenantId: string;
    requestedBy: string;
    goal: string;
    platform: string;
  }): Promise<StudioSessionRecord> {
    const bundle = this.generator
      ? await this.generator.generate({ goal: input.goal, platform: input.platform })
      : null;
    const status = bundle ? 'generated' : 'draft';
    const result = await this.pool.query(
      `INSERT INTO studio_sessions (tenant_id, requested_by, goal, platform, status, bundle)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, goal, platform, status, bundle`,
      [input.tenantId, input.requestedBy, input.goal, input.platform, status, bundle ? JSON.stringify(bundle) : null],
    );
    return this.map(result.rows[0]);
  }

  async list(tenantId: string): Promise<StudioSessionRecord[]> {
    const result = await this.pool.query(
      `SELECT id, goal, platform, status, bundle FROM studio_sessions
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async submit(tenantId: string, id: string): Promise<StudioSessionRecord> {
    const current = await this.get(tenantId, id);
    if (!current) throw new StudioNotFoundError();
    if (!current.bundle || current.status !== 'generated') throw new StudioConflictError();
    const result = await this.pool.query(
      `UPDATE studio_sessions SET status = 'pending_review', updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, goal, platform, status, bundle`,
      [tenantId, id],
    );
    return this.map(result.rows[0]);
  }

  async review(input: {
    tenantId: string;
    id: string;
    reviewerId: string;
    decision: 'approve' | 'reject';
    reason?: string;
  }): Promise<StudioSessionRecord> {
    const result = await this.pool.query(
      `UPDATE studio_sessions
       SET status = $1, reviewer_id = $2, reason = $3, updated_at = now()
       WHERE tenant_id = $4 AND id = $5 AND status = 'pending_review'
       RETURNING id, goal, platform, status, bundle`,
      [input.decision === 'approve' ? 'approved' : 'rejected', input.reviewerId, input.reason ?? null, input.tenantId, input.id],
    );
    if (!result.rows[0]) throw new StudioNotFoundError();
    return this.map(result.rows[0]);
  }

  private async get(tenantId: string, id: string): Promise<StudioSessionRecord | null> {
    const result = await this.pool.query(
      `SELECT id, goal, platform, status, bundle FROM studio_sessions
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  private map(row: {
    id: string;
    goal: string;
    platform: string;
    status: string;
    bundle: StudioBundle | null;
  }): StudioSessionRecord {
    return {
      id: row.id,
      goal: row.goal,
      platform: row.platform,
      status: row.status,
      bundle: row.bundle,
    };
  }
}
