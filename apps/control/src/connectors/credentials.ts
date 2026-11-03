import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { decryptSecret, encryptSecret } from '../secrets/crypto.js';

export function resolveExternalCredential(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, unknown>> | null {
  const [scheme, ...rest] = ref.split(':');
  const target = rest.join(':');
  if (!target) return null;
  try {
    if (scheme === 'env') {
      const raw = env[target];
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    }
    if (scheme === 'file') {
      return JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export class ConnectorCredentialService {
  constructor(
    private readonly pool: Pool,
    private readonly secret: string,
  ) {}

  async set(
    tenantId: string,
    connectorId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const exists = await this.pool.query(
      'SELECT 1 FROM connectors WHERE tenant_id = $1 AND id = $2',
      [tenantId, connectorId],
    );
    if (exists.rowCount === 0) return false;
    await this.pool.query(
      `INSERT INTO connector_credentials (connector_id, tenant_id, encrypted_payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (connector_id) DO UPDATE SET
         encrypted_payload = EXCLUDED.encrypted_payload,
         updated_at = now()`,
      [connectorId, tenantId, encryptSecret(JSON.stringify(payload), this.secret)],
    );
    return true;
  }

  async get(
    tenantId: string,
    connectorId: string,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const result = await this.pool.query<{ encrypted_payload: string }>(
      'SELECT encrypted_payload FROM connector_credentials WHERE tenant_id = $1 AND connector_id = $2',
      [tenantId, connectorId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return JSON.parse(decryptSecret(row.encrypted_payload, this.secret)) as Record<string, unknown>;
  }
}
