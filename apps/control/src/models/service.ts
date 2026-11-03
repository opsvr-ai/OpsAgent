import type { Pool } from 'pg';
import { encryptSecret } from '../secrets/crypto.js';

export interface ModelProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly status: string;
}

export class ModelProviderService {
  constructor(
    private readonly pool: Pool,
    private readonly secret: string,
  ) {}

  async list(tenantId: string): Promise<ModelProviderRecord[]> {
    const result = await this.pool.query(
      `SELECT id, name, provider, base_url, model, status FROM model_providers
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async create(input: {
    tenantId: string;
    name: string;
    provider: string;
    baseUrl: string;
    model: string;
    apiKey: string;
  }): Promise<ModelProviderRecord> {
    const encrypted = encryptSecret(input.apiKey, this.secret);
    const result = await this.pool.query(
      `INSERT INTO model_providers
         (tenant_id, name, provider, base_url, model, api_key_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, provider, base_url, model, status`,
      [input.tenantId, input.name, input.provider, input.baseUrl, input.model, encrypted],
    );
    return this.map(result.rows[0]);
  }

  private map(row: {
    id: string;
    name: string;
    provider: string;
    base_url: string;
    model: string;
    status: string;
  }): ModelProviderRecord {
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      status: row.status,
    };
  }
}
