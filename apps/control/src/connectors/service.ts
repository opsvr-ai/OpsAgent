import type { Pool } from 'pg';

export interface ConnectorRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly connectorType: string;
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialRef: string | null;
  readonly status: string;
}

export interface CreateConnectorInput {
  readonly tenantId: string;
  readonly connectorType: string;
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialRef?: string;
}

export class ConnectorService {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<ConnectorRecord[]> {
    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      connector_type: string;
      name: string;
      config: Record<string, unknown>;
      credential_ref: string | null;
      status: string;
    }>(
      `SELECT id, tenant_id, connector_type, name, config, credential_ref, status
       FROM connectors WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async create(input: CreateConnectorInput): Promise<ConnectorRecord> {
    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      connector_type: string;
      name: string;
      config: Record<string, unknown>;
      credential_ref: string | null;
      status: string;
    }>(
      `INSERT INTO connectors (tenant_id, connector_type, name, config, credential_ref, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'draft')
       RETURNING id, tenant_id, connector_type, name, config, credential_ref, status`,
      [input.tenantId, input.connectorType, input.name, JSON.stringify(input.config), input.credentialRef ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('connector_insert_failed');
    return this.map(row);
  }

  private map(row: {
    id: string;
    tenant_id: string;
    connector_type: string;
    name: string;
    config: Record<string, unknown>;
    credential_ref: string | null;
    status: string;
  }): ConnectorRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      connectorType: row.connector_type,
      name: row.name,
      config: row.config,
      credentialRef: row.credential_ref,
      status: row.status,
    };
  }
}
