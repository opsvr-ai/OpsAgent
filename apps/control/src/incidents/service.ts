import type { Pool } from 'pg';
import { sendWebhook } from '../messages/webhook.js';
import { AgentCommandService } from '../agents/commands.js';

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
  readonly source: string;
  readonly appSystemId: string | null;
  readonly rootCause: string | null;
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
       RETURNING id, title, severity, status, commander_id, source, app_system_id, root_cause`,
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
      `SELECT id, title, severity, status, commander_id, source, app_system_id, root_cause FROM incidents
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async get(tenantId: string, id: string): Promise<IncidentRecord | null> {
    const result = await this.pool.query(
      `SELECT id, title, severity, status, commander_id, source, app_system_id, root_cause FROM incidents
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async getWithEvents(tenantId: string, id: string): Promise<{
    incident: IncidentRecord;
    events: Array<{ id: string; type: string; payload: Record<string, unknown>; createdAt: string }>;
    evidence: Array<{ id: string; kind: string; source: string; summary: string; payload: Record<string, unknown>; createdAt: string }>;
    hypotheses: Array<{ id: string; statement: string; confidence: number; status: string; createdAt: string }>;
    tickets: Array<{ id: string; title: string; assignee: string; status: string; createdAt: string }>;
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
    const evidence = await this.pool.query<{
      id: string; kind: string; source: string; summary: string; payload: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT id, kind, source, summary, payload, created_at FROM incident_evidence
       WHERE tenant_id = $1 AND incident_id = $2 ORDER BY created_at ASC`,
      [tenantId, id],
    );
    const hypotheses = await this.pool.query<{
      id: string; statement: string; confidence: number; status: string; created_at: Date;
    }>(
      `SELECT id, statement, confidence, status, created_at FROM incident_hypotheses
       WHERE tenant_id = $1 AND incident_id = $2 ORDER BY created_at ASC`,
      [tenantId, id],
    );
    const tickets = await this.pool.query<{
      id: string; title: string; assignee: string; status: string; created_at: Date;
    }>(
      `SELECT id, title, assignee, status, created_at FROM incident_tickets
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
      evidence: evidence.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        source: row.source,
        summary: row.summary,
        payload: row.payload,
        createdAt: row.created_at.toISOString(),
      })),
      hypotheses: hypotheses.rows.map((row) => ({
        id: row.id,
        statement: row.statement,
        confidence: row.confidence,
        status: row.status,
        createdAt: row.created_at.toISOString(),
      })),
      tickets: tickets.rows.map((row) => ({
        id: row.id,
        title: row.title,
        assignee: row.assignee,
        status: row.status,
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
       RETURNING id, title, severity, status, commander_id, source, app_system_id, root_cause`,
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

  async investigate(input: {
    tenantId: string;
    id: string;
    actorId: string;
  }): Promise<Awaited<ReturnType<IncidentService['getWithEvents']>> | null> {
    const incident = await this.pool.query<{
      trigger_event_id: string | null;
      app_system_id: string | null;
      status: string;
    }>(
      `SELECT trigger_event_id, app_system_id, status FROM incidents
       WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.id],
    );
    const row = incident.rows[0];
    if (!row) return null;
    const trigger = await this.pool.query<{ agent_id: string; hostname: string }>(
      `SELECT e.agent_id, a.hostname FROM agent_events e
       JOIN agents a ON a.id = e.agent_id
       WHERE e.id = $1`,
      [row.trigger_event_id],
    );
    const agent = trigger.rows[0];
    if (!agent) {
      await this.pool.query(
        `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
         VALUES ($1, $2, $3, 'investigation_skipped', $4::jsonb)`,
        [input.tenantId, input.id, input.actorId, JSON.stringify({ reason: 'no_trigger_agent' })],
      );
      return this.getWithEvents(input.tenantId, input.id);
    }

    const commands = new AgentCommandService(this.pool);
    const command = await commands.create({
      tenantId: input.tenantId,
      agentId: agent.agent_id,
      type: 'inspect',
      input: { question: '应用系统故障排查：检查磁盘、内存、服务、进程、端口和近期日志' },
    });
    if (!command) return null;

    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'investigation_started', $4::jsonb)`,
      [input.tenantId, input.id, input.actorId, JSON.stringify({ hostname: agent.hostname, commandId: command.id })],
    );
    await this.pool.query(
      `UPDATE incident_tickets SET status = 'in_progress' WHERE tenant_id = $1 AND incident_id = $2`,
      [input.tenantId, input.id],
    );

    let current = command;
    for (let attempt = 0; attempt < 15 && current.status !== 'completed'; attempt += 1) {
      await delay(1000);
      current = (await commands.get(input.tenantId, agent.agent_id, command.id)) ?? current;
    }
    const result = typeof current.result === 'object' && current.result !== null
      ? current.result as Record<string, unknown>
      : {};
    const completed = current.status === 'completed';
    const answer = completed && typeof result.answer === 'string'
      ? result.answer
      : `Agent 检查已下发，当前状态 ${current.status}，等待下次心跳返回结果。`;
    const evidenceSummary = answer.length > 1200 ? `${answer.slice(0, 1200)}\n…（完整输出见证据 payload）` : answer;
    await this.pool.query(
      `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
       VALUES ($1, $2, 'host_inspection', 'opsagent-agent', $3, $4::jsonb)`,
      [input.tenantId, input.id, evidenceSummary, JSON.stringify({
        commandId: current.id,
        hostname: agent.hostname,
        status: current.status,
        result,
      })],
    );
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.tenantId,
        input.id,
        input.actorId,
        completed ? 'investigation_completed' : 'investigation_pending',
        JSON.stringify({ hostname: agent.hostname, commandId: current.id, status: current.status }),
      ],
    );
    if (completed) {
      await this.pool.query(
        `UPDATE incident_tickets SET status = 'done' WHERE tenant_id = $1 AND incident_id = $2`,
        [input.tenantId, input.id],
      );
      await this.pool.query(
        `UPDATE incident_hypotheses SET confidence = GREATEST(confidence, 85), status = 'supported'
         WHERE tenant_id = $1 AND incident_id = $2`,
        [input.tenantId, input.id],
      );
    }
    return this.getWithEvents(input.tenantId, input.id);
  }

  private map(row: {
    id: string;
    title: string;
    severity: string;
    status: string;
    commander_id: string | null;
    source?: string;
    app_system_id?: string | null;
    root_cause?: string | null;
  }): IncidentRecord {
    return {
      id: row.id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      commanderId: row.commander_id,
      source: row.source ?? 'manual',
      appSystemId: row.app_system_id ?? null,
      rootCause: row.root_cause ?? null,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
