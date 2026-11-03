import type { Pool } from 'pg';
import { sendWebhook } from '../messages/webhook.js';

export const INCIDENT_STATUSES = [
  'open',
  'investigating',
  'mitigated',
  'resolved',
  'closed',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export interface IncidentRecord {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly commanderId: string | null;
}

export class IncidentService {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    tenantId: string;
    actorId: string;
    title: string;
    severity: string;
  }): Promise<IncidentRecord> {
    const incident = await this.pool.query(
      `INSERT INTO incidents (tenant_id, title, severity, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, severity, status, commander_id`,
      [input.tenantId, input.title, input.severity, input.actorId],
    );
    const row = incident.rows[0];
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'created', $4::jsonb)`,
      [input.tenantId, row.id, input.actorId, JSON.stringify({ severity: input.severity })],
    );
    await this.pool.query(
      `INSERT INTO messages (tenant_id, title, body, severity)
       VALUES ($1, $2, $3, 'warning')`,
      [input.tenantId, `新事件 ${input.severity}`, input.title],
    );
    void sendWebhook({
      title: `新事件 ${input.severity}`,
      body: input.title,
      severity: 'warning',
    });
    return this.map(row);
  }

  async list(tenantId: string): Promise<IncidentRecord[]> {
    const result = await this.pool.query(
      `SELECT id, title, severity, status, commander_id FROM incidents
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async get(tenantId: string, id: string): Promise<IncidentRecord | null> {
    const result = await this.pool.query(
      `SELECT id, title, severity, status, commander_id FROM incidents
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async getWithEvents(tenantId: string, id: string): Promise<{
    incident: IncidentRecord;
    events: Array<{ id: string; type: string; payload: Record<string, unknown>; createdAt: string }>;
  } | null> {
    const incident = await this.get(tenantId, id);
    if (!incident) return null;
    const events = await this.pool.query<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, type, payload, created_at FROM incident_events
       WHERE tenant_id = $1 AND incident_id = $2 ORDER BY created_at ASC`,
      [tenantId, id],
    );
    return {
      incident,
      events: events.rows.map((row) => ({
        id: row.id,
        type: row.type,
        payload: row.payload,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async update(input: {
    tenantId: string;
    id: string;
    actorId: string;
    status?: IncidentStatus;
    commanderId?: string | null;
  }): Promise<IncidentRecord | null> {
    const result = await this.pool.query(
      `UPDATE incidents
       SET status = COALESCE($1, status),
           commander_id = CASE WHEN $2::boolean THEN $3::uuid ELSE commander_id END,
           updated_at = now()
       WHERE tenant_id = $4 AND id = $5
       RETURNING id, title, severity, status, commander_id`,
      [
        input.status ?? null,
        input.commanderId !== undefined,
        input.commanderId ?? null,
        input.tenantId,
        input.id,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'updated', $4::jsonb)`,
      [
        input.tenantId,
        input.id,
        input.actorId,
        JSON.stringify({ status: input.status ?? null, commanderId: input.commanderId ?? null }),
      ],
    );
    return this.map(row);
  }

  private map(row: {
    id: string;
    title: string;
    severity: string;
    status: string;
    commander_id: string | null;
  }): IncidentRecord {
    return {
      id: row.id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      commanderId: row.commander_id,
    };
  }
}
