import type { Pool } from 'pg';

export interface AppHealthFinding {
  readonly agentId: string;
  readonly hostname: string;
  readonly status: 'healthy' | 'warning' | 'critical' | 'offline';
  readonly issues: string[];
  readonly metrics: Record<string, unknown>;
  readonly applications: unknown[];
  readonly events: string[];
  readonly logSignals: string[];
}

export interface AppHealthCheck {
  readonly id: string;
  readonly appSystemId: string;
  readonly appSystemName: string;
  readonly status: string;
  readonly summary: string;
  readonly rootCause: string;
  readonly findings: AppHealthFinding[];
  readonly triggerAgentId: string | null;
  readonly triggerEventId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

interface NodeRow {
  id: string;
  hostname: string;
  status: string;
  last_seen: Date;
  metrics: Record<string, unknown> | null;
  system_info: Record<string, unknown> | null;
  applications: unknown[] | null;
}

interface EventRow {
  id: string;
  agent_id: string;
  fingerprint: string;
  severity: string;
  title: string;
  detail: string;
  details: Record<string, unknown>;
  created_at: Date;
}

function asObject(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function logSignals(details: Record<string, unknown>): string[] {
  const groups: Record<string, unknown>[] = [];
  const appLogs = asObject(details.applicationLogs);
  const systemLogs = asObject(details.systemLogs);
  groups.push(appLogs, systemLogs);
  if (typeof details.agentLog === 'string') groups.push({ agent: details.agentLog });
  const signals: string[] = [];
  const pattern = /(error|exception|failed|failure|fatal|panic|oom|out of memory|no space|permission denied|timeout|refused)/i;
  for (const group of groups) {
    for (const [name, value] of Object.entries(group)) {
      if (typeof value !== 'string') continue;
      const lines = value.split('\n').filter((line) => pattern.test(line)).slice(0, 4);
      if (lines.length > 0) signals.push(`${name}: ${lines.join(' | ').slice(0, 500)}`);
    }
  }
  return signals.slice(0, 8);
}

function issueForEvent(event: EventRow): string {
  if (event.fingerprint === 'disk-low') return `${event.title}：${event.detail}`;
  if (event.fingerprint === 'memory-high') return `${event.title}：${event.detail}`;
  return `${event.title}：${event.detail}`;
}

export function deriveRootCause(findings: AppHealthFinding[], triggerAgentId: string): string {
  const trigger = findings.find((finding) => finding.agentId === triggerAgentId);
  if (trigger?.status === 'offline') {
    return `${trigger.hostname}：节点离线，最近心跳异常`;
  }
  const counts = new Map<string, { count: number; hosts: string[] }>();
  for (const finding of findings) {
    for (const issue of new Set(finding.issues)) {
      const entry = counts.get(issue) ?? { count: 0, hosts: [] };
      entry.count += 1;
      entry.hosts.push(finding.hostname);
      counts.set(issue, entry);
    }
  }
  const shared = [...counts.entries()]
    .filter(([, value]) => value.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)[0];
  if (shared) {
    const [issue, value] = shared;
    return `多节点共同异常：${issue}（${value.count} 个节点：${value.hosts.join('、')}）`;
  }
  if (trigger && trigger.issues.length > 0) {
    return `${trigger.hostname}：${trigger.issues[0]}`;
  }
  const anomalous = findings.find((finding) => finding.status !== 'healthy');
  if (anomalous && anomalous.issues.length > 0) {
    return `${anomalous.hostname}：${anomalous.issues[0]}`;
  }
  return '未发现明确的应用系统级根因';
}

export class AppHealthService {
  constructor(private readonly pool: Pool) {}

  async triggerForAgentEvent(agentId: string, eventId: string): Promise<AppHealthCheck | null> {
    const agentResult = await this.pool.query<{
      id: string;
      tenant_id: string;
      hostname: string;
      app_system_id: string | null;
    }>('SELECT id, tenant_id, hostname, app_system_id FROM agents WHERE id = $1', [agentId]);
    const agent = agentResult.rows[0];
    if (!agent?.app_system_id) return null;

    const existing = await this.pool.query(
      `SELECT id FROM app_system_health_checks
       WHERE trigger_event_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [eventId],
    );
    if (existing.rows[0]) return this.get(agent.tenant_id, String(existing.rows[0].id));

    const systemResult = await this.pool.query<{ id: string; name: string; code: string }>(
      'SELECT id, name, code FROM app_systems WHERE id = $1 AND tenant_id = $2',
      [agent.app_system_id, agent.tenant_id],
    );
    const system = systemResult.rows[0];
    if (!system) return null;

    const nodesResult = await this.pool.query<NodeRow>(
      `SELECT id, hostname, status, last_seen, metrics, system_info, applications
       FROM agents WHERE tenant_id = $1 AND app_system_id = $2 ORDER BY hostname`,
      [agent.tenant_id, agent.app_system_id],
    );
    const eventsResult = await this.pool.query<EventRow>(
      `SELECT id, agent_id, fingerprint, severity, title, detail, details, created_at
       FROM agent_events WHERE tenant_id = $1 AND status = 'open'
       ORDER BY detected_at DESC`,
      [agent.tenant_id],
    );
    const triggerEvent = eventsResult.rows.find((event) => event.id === eventId);
    const eventsByAgent = new Map<string, EventRow[]>();
    for (const event of eventsResult.rows) {
      const list = eventsByAgent.get(event.agent_id) ?? [];
      list.push(event);
      eventsByAgent.set(event.agent_id, list);
    }

    const findings: AppHealthFinding[] = [];
    for (const node of nodesResult.rows) {
      const events = eventsByAgent.get(node.id) ?? [];
      const issues = events.map(issueForEvent);
      for (const app of node.applications ?? []) {
        const appObject = asObject(app);
        const status = String(appObject.status ?? '');
        if (status && !/running|up|active|healthy/i.test(status)) {
          issues.push(`应用 ${String(appObject.name ?? 'unknown')} 状态为 ${status}`);
        }
      }
      const isOffline = node.status !== 'online';
      if (isOffline) issues.push(`节点离线，最近心跳 ${node.last_seen.toISOString()}`);
      const severityRank = events.some((event) => event.severity === 'critical') || isOffline ? 'critical' : events.length > 0 ? 'warning' : 'healthy';
      findings.push({
        agentId: node.id,
        hostname: node.hostname,
        status: severityRank,
        issues,
        metrics: node.metrics ?? {},
        applications: node.applications ?? [],
        events: events.map((event) => `${event.severity}: ${event.title}`),
        logSignals: logSignals(triggerEvent?.agent_id === node.id ? triggerEvent.details : {}),
      });
    }

    const anomalous = findings.filter((finding) => finding.status !== 'healthy');
    let rootCause = deriveRootCause(findings, agentId);
    const logEvidence = [...new Set(findings.flatMap((finding) => finding.logSignals))].slice(0, 3);
    if (logEvidence.length > 0) {
      rootCause += `；应用/系统日志出现异常关键字：${logEvidence[0]?.slice(0, 220) ?? ''}`;
    }
    const summary = `应用系统 ${system.name} 检查 ${findings.length} 个节点，${anomalous.length} 个异常。`;
    const severity = anomalous.some((finding) => finding.status === 'critical') ? 'critical' : 'warning';

    const inserted = await this.pool.query<{ id: string; created_at: Date; completed_at: Date }>(
      `INSERT INTO app_system_health_checks
         (tenant_id, app_system_id, trigger_agent_id, trigger_event_id, status, summary, root_cause, findings, completed_at)
       VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7::jsonb, now())
       RETURNING id, created_at, completed_at`,
      [agent.tenant_id, agent.app_system_id, agentId, eventId, summary, rootCause, JSON.stringify(findings)],
    );
    if (anomalous.length > 0) {
      await this.pool.query(
        `INSERT INTO messages (tenant_id, title, body, severity)
         VALUES ($1, $2, $3, $4)`,
        [
          agent.tenant_id,
          `应用系统故障定位：${system.name}`,
          `${summary}\n${rootCause}`,
          severity,
        ],
      );
      await this.createIncident({
        tenantId: agent.tenant_id,
        appSystemId: agent.app_system_id,
        eventId,
        title: `应用系统 ${system.name} 节点异常：${agent.hostname}`,
        severity: severity === 'critical' ? 'P1' : 'P2',
        summary,
        rootCause,
        findings,
        triggerAgent: agent.hostname,
      });
    }
    const row = inserted.rows[0];
    return row ? this.get(agent.tenant_id, String(row.id)) : null;
  }

  async get(tenantId: string, id: string): Promise<AppHealthCheck | null> {
    const result = await this.pool.query(
      `SELECT h.id, h.app_system_id, s.name AS app_system_name, h.status, h.summary, h.root_cause,
              h.findings, h.trigger_agent_id, h.trigger_event_id, h.created_at, h.completed_at
       FROM app_system_health_checks h
       JOIN app_systems s ON s.id = h.app_system_id
       WHERE h.tenant_id = $1 AND h.id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async latest(tenantId: string, appSystemId?: string): Promise<AppHealthCheck[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (h.app_system_id)
              h.id, h.app_system_id, s.name AS app_system_name, h.status, h.summary, h.root_cause,
              h.findings, h.trigger_agent_id, h.trigger_event_id, h.created_at, h.completed_at
       FROM app_system_health_checks h
       JOIN app_systems s ON s.id = h.app_system_id
       WHERE h.tenant_id = $1 ${appSystemId ? 'AND h.app_system_id = $2' : ''}
       ORDER BY h.app_system_id, h.created_at DESC`,
      appSystemId ? [tenantId, appSystemId] : [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  private async createIncident(input: {
    tenantId: string;
    appSystemId: string;
    eventId: string;
    title: string;
    severity: string;
    summary: string;
    rootCause: string;
    findings: AppHealthFinding[];
    triggerAgent: string;
  }): Promise<void> {
    const existing = await this.pool.query(
      `SELECT id FROM incidents
       WHERE tenant_id = $1 AND app_system_id = $2
         AND status NOT IN ('resolved', 'closed')
         AND title = $3
       LIMIT 1`,
      [input.tenantId, input.appSystemId, input.title],
    );
    if (existing.rows[0]) return;
    const existingEvent = await this.pool.query('SELECT id FROM incidents WHERE trigger_event_id = $1 LIMIT 1', [input.eventId]);
    if (existingEvent.rows[0]) return;
    const user = await this.pool.query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 AND m.status = 'active'
       ORDER BY u.created_at LIMIT 1`,
      [input.tenantId],
    );
    const actorId = user.rows[0]?.id;
    if (!actorId) return;
    const incident = await this.pool.query<{ id: string }>(
      `INSERT INTO incidents
         (tenant_id, title, severity, source, app_system_id, trigger_event_id, root_cause, created_by)
       VALUES ($1, $2, $3, 'agent_health', $4, $5, $6, $7)
       RETURNING id`,
      [input.tenantId, input.title, input.severity, input.appSystemId, input.eventId, input.rootCause, actorId],
    );
    const incidentId = incident.rows[0]?.id;
    if (!incidentId) return;
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'source_detected', $4::jsonb)`,
      [input.tenantId, incidentId, actorId, JSON.stringify({
        source: 'agent_health',
        triggerAgent: input.triggerAgent,
        summary: input.summary,
      })],
    );
    await this.pool.query(
      `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
       VALUES ($1, $2, 'root_cause', 'opsagent-agent', $3, $4::jsonb)`,
      [input.tenantId, incidentId, input.rootCause, JSON.stringify({ findings: input.findings })],
    );
    const logSignals = input.findings.flatMap((finding) => finding.logSignals);
    if (logSignals.length > 0) {
      await this.pool.query(
        `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
         VALUES ($1, $2, 'log_signal', 'application_log', $3, $4::jsonb)`,
        [input.tenantId, incidentId, logSignals[0]?.slice(0, 500) ?? '', JSON.stringify({ signals: logSignals })],
      );
    }
    await this.pool.query(
      `INSERT INTO incident_hypotheses (tenant_id, incident_id, statement, confidence, status)
       VALUES ($1, $2, $3, 80, 'supported')`,
      [input.tenantId, incidentId, input.rootCause],
    );
    await this.pool.query(
      `INSERT INTO incident_tickets (tenant_id, incident_id, title, assignee, status)
       VALUES ($1, $2, $3, '值班 SRE', 'todo')`,
      [input.tenantId, incidentId, `检查 ${input.triggerAgent} 主机与日志证据`],
    );
  }

  private map(row: Record<string, unknown>): AppHealthCheck {
    return {
      id: String(row.id),
      appSystemId: String(row.app_system_id),
      appSystemName: String(row.app_system_name),
      status: String(row.status),
      summary: String(row.summary),
      rootCause: String(row.root_cause),
      findings: Array.isArray(row.findings) ? row.findings as AppHealthFinding[] : [],
      triggerAgentId: row.trigger_agent_id ? String(row.trigger_agent_id) : null,
      triggerEventId: row.trigger_event_id ? String(row.trigger_event_id) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ? String(row.completed_at) : null,
    };
  }
}
