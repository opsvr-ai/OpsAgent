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
  readonly isAgentDefault: boolean;
}

export class ModelProviderService {
  constructor(
    private readonly pool: Pool,
    private readonly secret: string,
  ) {}

  async list(tenantId: string): Promise<ModelProviderRecord[]> {
    const result = await this.pool.query(
      `SELECT id, name, provider, base_url, model, status, is_agent_default FROM model_providers
       WHERE tenant_id = $1 ORDER BY is_agent_default DESC, created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async listAvailable(tenantId: string): Promise<ModelProviderRecord[]> {
    const result = await this.pool.query(
      `SELECT id, name, provider, base_url, model, status, is_agent_default FROM model_providers
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY is_agent_default DESC, created_at DESC`,
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
       RETURNING id, name, provider, base_url, model, status, is_agent_default`,
      [input.tenantId, input.name, input.provider, input.baseUrl, input.model, encrypted],
    );
    return this.map(result.rows[0]);
  }

  async createMany(input: {
    tenantId: string;
    name: string;
    provider: string;
    baseUrl: string;
    models: string[];
    apiKey: string;
  }): Promise<ModelProviderRecord[]> {
    const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
    if (models.length === 0) return [];
    const encrypted = encryptSecret(input.apiKey, this.secret);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const created: ModelProviderRecord[] = [];
      for (const model of models) {
        const name = models.length > 1 ? `${input.name || model} · ${model}` : input.name || model;
        const result = await client.query(
          `INSERT INTO model_providers
             (tenant_id, name, provider, base_url, model, api_key_encrypted)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, name, provider, base_url, model, status, is_agent_default`,
          [input.tenantId, name, input.provider, input.baseUrl, model, encrypted],
        );
        created.push(this.map(result.rows[0]));
      }
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async update(
    tenantId: string,
    id: string,
    input: {
      name: string;
      provider: string;
      baseUrl: string;
      model: string;
      apiKey?: string;
      status?: 'active' | 'disabled';
    },
  ): Promise<ModelProviderRecord | null> {
    const encrypted = input.apiKey ? encryptSecret(input.apiKey, this.secret) : null;
    const result = await this.pool.query(
      `UPDATE model_providers
       SET name = $3, provider = $4, base_url = $5, model = $6,
           api_key_encrypted = COALESCE($7, api_key_encrypted),
           status = COALESCE($8, status), updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, name, provider, base_url, model, status, is_agent_default`,
      [tenantId, id, input.name, input.provider, input.baseUrl, input.model, encrypted, input.status ?? null],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM model_providers WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setAgentDefault(tenantId: string, id: string): Promise<ModelProviderRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query(
        'SELECT id FROM model_providers WHERE tenant_id = $1 AND id = $2 AND status = $3',
        [tenantId, id, 'active'],
      );
      if (!target.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        'UPDATE model_providers SET is_agent_default = false, updated_at = now() WHERE tenant_id = $1 AND is_agent_default',
        [tenantId],
      );
      const result = await client.query(
        `UPDATE model_providers SET is_agent_default = true, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, name, provider, base_url, model, status, is_agent_default`,
        [tenantId, id],
      );
      await client.query('COMMIT');
      return result.rows[0] ? this.map(result.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolve(tenantId: string, modelId?: string): Promise<ResolvedModelProvider | null> {
    const result = await this.pool.query<{
      provider: string;
      base_url: string;
      model: string;
      api_key_encrypted: string;
    }>(
      `SELECT provider, base_url, model, api_key_encrypted FROM model_providers
       WHERE tenant_id = $1 AND status = 'active'
         AND ($2::text IS NULL OR id::text = $2)
       ORDER BY is_agent_default DESC, created_at DESC LIMIT 1`,
      [tenantId, modelId ?? null],
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
    is_agent_default: boolean;
  }): ModelProviderRecord {
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      status: row.status,
      isAgentDefault: row.is_agent_default,
    };
  }
}
