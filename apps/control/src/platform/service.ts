import type { Pool } from 'pg';

export interface TenantRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

export class PlatformTenantService {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<TenantRecord[]> {
    const result = await this.pool.query(
      'SELECT id, name, slug, status FROM tenants ORDER BY created_at DESC',
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
    }));
  }

  async create(input: { name: string; slug: string }): Promise<TenantRecord> {
    const result = await this.pool.query(
      `INSERT INTO tenants (name, slug) VALUES ($1, $2)
       RETURNING id, name, slug, status`,
      [input.name, input.slug],
    );
    const row = result.rows[0];
    return { id: row.id, name: row.name, slug: row.slug, status: row.status };
  }
}
