import type { Pool } from 'pg';
import { decryptSecret, encryptSecret } from '../secrets/crypto.js';

export interface ResolvedModelProvider {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

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

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM model_providers WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resolve(tenantId: string): Promise<ResolvedModelProvider | null> {    const result = await this.pool.query<{
      provider: string;
      base_url: string;
      model: string;
      api_key_encrypted: string;
    }>(
      `SELECT provider, base_url, model, api_key_encrypted FROM model_providers
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      apiKey: decryptSecret(row.api_key_encrypted, this.secret),
    };
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
