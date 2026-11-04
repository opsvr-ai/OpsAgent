import { randomUUID, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandSigner, getCommandSigner } from './signing.js';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyAgentResult(publicKeyBase64: string, payload: string, signature: string): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export interface AgentCommandRecord {
  readonly id: string;
  readonly agentId: string;
  readonly type: string;
  readonly status: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly createdAt: string;
  readonly signedPayload: string | null;
  readonly signature: string | null;
  readonly nonce: string | null;
  readonly keyId: string | null;
  readonly expiresAt: string | null;
}

export class AgentCommandService {
  constructor(
    private readonly pool: Pool,
    private readonly signer: CommandSigner = getCommandSigner(),
  ) {}

  async create(input: {
    tenantId: string;
    agentId: string;
    type: string;
    input?: Readonly<Record<string, unknown>>;
    requestedBy?: string;
    instruction?: string;
    intent?: Readonly<Record<string, unknown>>;
    clientRequestId?: string;
    incidentId?: string;
  }): Promise<AgentCommandRecord | null> {
    const agent = await this.pool.query(
      'SELECT 1 FROM agents WHERE tenant_id = $1 AND id = $2',
      [input.tenantId, input.agentId],
    );
    if (agent.rowCount === 0) return null;
    const payload = input.input ?? {};
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const signed = this.signer.signCommand(payload, nonce, expiresAt);
    const result = await this.pool.query(
      `INSERT INTO agent_commands
         (tenant_id, agent_id, type, payload, signed_payload, signature, nonce, key_id, expires_at,
          requested_by, instruction, instruction_intent, client_request_id, incident_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
       RETURNING id, agent_id, type, status, payload, result, signed_payload, signature, nonce, key_id, expires_at, created_at`,
      [
        input.tenantId,
        input.agentId,
        input.type,
        JSON.stringify(payload),
        signed.signedPayload,
        signed.signature,
        nonce,
        this.signer.keyId,
        expiresAt,
        input.requestedBy ?? null,
        input.instruction ?? null,
        input.intent ? JSON.stringify(input.intent) : null,
        input.clientRequestId ?? null,
        input.incidentId ?? null,
      ],
    );
    return this.map(result.rows[0]);
  }

  async list(tenantId: string, agentId: string): Promise<AgentCommandRecord[]> {
    const result = await this.pool.query(
      `SELECT id, agent_id, type, status, payload, result, signed_payload, signature, nonce, key_id, expires_at, created_at FROM agent_commands
       WHERE tenant_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [tenantId, agentId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async pending(agentId: string, key: string): Promise<AgentCommandRecord | null> {
    const agent = await this.pool.query(
      'SELECT 1 FROM agents WHERE id = $1 AND agent_key = $2',
      [agentId, key],
    );
    if (agent.rowCount === 0) return null;
    const result = await this.pool.query(
      `UPDATE agent_commands SET status = 'dispatched', dispatched_at = now()
       WHERE id = (
         SELECT id FROM agent_commands
         WHERE agent_id = $1 AND status = 'pending'
         ORDER BY created_at ASC LIMIT 1
       )
       RETURNING id, agent_id, type, status, payload, result, signed_payload, signature, nonce, key_id, expires_at, created_at`,
      [agentId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async get(tenantId: string, agentId: string, commandId: string): Promise<AgentCommandRecord | null> {
    const result = await this.pool.query(
      `SELECT id, agent_id, type, status, payload, result, signed_payload, signature, nonce, key_id, expires_at, created_at FROM agent_commands
       WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
      [tenantId, agentId, commandId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async complete(input: {
    agentId: string;
    commandId: string;
    key: string;
    result: unknown;
    resultSigned?: string;
    resultSignature?: string;
  }): Promise<AgentCommandRecord | null> {
    const agent = await this.pool.query<{ tenant_id: string; result_public_key: string | null }>(
      'SELECT tenant_id, result_public_key FROM agents WHERE id = $1 AND agent_key = $2',
      [input.agentId, input.key],
    );
    if (agent.rowCount === 0) return null;
    let result = input.result;
    const resultPublicKey = agent.rows[0]?.result_public_key;
    if (resultPublicKey) {
      if (!input.resultSigned || !input.resultSignature) {
        throw new Error('result_signature_required');
      }
      if (!verifyAgentResult(resultPublicKey, input.resultSigned, input.resultSignature)) {
        throw new Error('invalid_result_signature');
      }
      try {
        result = JSON.parse(input.resultSigned);
      } catch {
        throw new Error('invalid_result_payload');
      }
    }
    const updated = await this.pool.query(
      `UPDATE agent_commands
       SET status = 'completed', result = $1::jsonb, completed_at = now()
       WHERE id = $2 AND agent_id = $3
       RETURNING id, agent_id, type, status, payload, result, signed_payload, signature, nonce, key_id, expires_at, created_at`,
      [JSON.stringify(result), input.commandId, input.agentId],
    );
    const record = updated.rows[0];
    if (record && typeof result === 'object' && result !== null) {
      const discovery = (result as Record<string, unknown>).discovery;
      if (typeof discovery === 'object' && discovery !== null && !Array.isArray(discovery)) {
        const report = discovery as Record<string, unknown>;
        const tenantId = agent.rows[0]?.tenant_id;
        if (tenantId) {
          await this.pool.query(
            `UPDATE agents SET
               system_info = COALESCE($3::jsonb, system_info),
               applications = COALESCE($4::jsonb, applications),
               agent_info = COALESCE($5::jsonb, agent_info),
               discovery_at = now()
             WHERE id = $1 AND tenant_id = $2`,
            [
              input.agentId,
              tenantId,
              report.system ? JSON.stringify(report.system) : null,
              report.applications ? JSON.stringify(report.applications) : null,
              report.agent ? JSON.stringify(report.agent) : null,
            ],
          );
        }
      }
    }
    return record ? this.map(record) : null;
  }

  private map(row: {
    id: string;
    agent_id: string;
    type: string;
    status: string;
    payload?: unknown;
    result: unknown;
    signed_payload?: string | null;
    signature?: string | null;
    nonce?: string | null;
    key_id?: string | null;
    expires_at?: Date | string | null;
    created_at: string;
  }): AgentCommandRecord {
    return {
      id: row.id,
      agentId: row.agent_id,
      type: row.type,
      status: row.status,
      input: typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
        ? row.payload as Record<string, unknown>
        : {},
      result: row.result,
      createdAt: row.created_at,
      signedPayload: row.signed_payload ?? null,
      signature: row.signature ?? null,
      nonce: row.nonce ?? null,
      keyId: row.key_id ?? null,
      expiresAt: row.expires_at
        ? (row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at)
        : null,
    };
  }
}

