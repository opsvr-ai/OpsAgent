import type { Pool } from 'pg';
import { sendWebhook } from '../messages/webhook.js';
import { AgentCommandService } from '../agents/commands.js';
import { ConnectorToolResolver } from '../connectors/runtime.js';

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
  readonly dueAt: string | null;
}

export const DEFAULT_INCIDENT_REPORT_TEMPLATE = `# 事件报告：{{title}}

- 事件 ID：{{id}}
- 严重度：{{severity}}
- 状态：{{status}}
- 来源：{{source}}
- 根因：{{rootCause}}

## 证据

{{evidence}}

## 故障假设

{{hypotheses}}

## 处置任务

{{tickets}}

## 时间线

{{timeline}}
`;

export class IncidentService {
  constructor(
    private readonly pool: Pool,
    private readonly tools = new ConnectorToolResolver(pool),
  ) {}

  async create(input: {
    tenantId: string;
    actorId: string;
    title: string;
    severity: string;
  }): Promise<IncidentRecord> {
    const incident = await this.pool.query(
      `INSERT INTO incidents (tenant_id, title, severity, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, severity, status, commander_id, source, app_system_id, root_cause, due_at`,
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
      `SELECT id, title, severity, status, commander_id, source, app_system_id, root_cause, due_at FROM incidents
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async get(tenantId: string, id: string): Promise<IncidentRecord | null> {
    const result = await this.pool.query(
      `SELECT id, title, severity, status, commander_id, source, app_system_id, root_cause, due_at FROM incidents
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
    approvals: Array<{ id: string; action: string; risk: string; status: string; details: Record<string, unknown>; reason: string | null; createdAt: string; decidedAt: string | null }>;
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
    const approvals = await this.pool.query<{
      id: string; action: string; risk: string; status: string; details: Record<string, unknown>;
      reason: string | null; created_at: Date; decided_at: Date | null;
    }>(
      `SELECT id, action, risk, status, details, reason, created_at, decided_at FROM incident_approvals
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
      approvals: approvals.rows.map((row) => ({
        id: row.id,
        action: row.action,
        risk: row.risk,
        status: row.status,
        details: row.details,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
        decidedAt: row.decided_at?.toISOString() ?? null,
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
       RETURNING id, title, severity, status, commander_id, source, app_system_id, root_cause, due_at`,
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

  async createFromSource(input: {
    tenantId: string;
    source: 'alertmanager' | 'zabbix' | 'webhook' | 'deployment';
    sourceRef: string;
    title: string;
    severity: string;
    appSystemId?: string;
    rootCause?: string;
    evidence?: Array<{ kind: string; source: string; summary: string; payload?: Record<string, unknown> }>;
  }): Promise<{ incident: IncidentRecord; created: boolean } | null> {
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM incidents WHERE tenant_id = $1 AND source = $2 AND source_ref = $3 LIMIT 1`,
      [input.tenantId, input.source, input.sourceRef],
    );
    if (existing.rows[0]) {
      const record = await this.get(input.tenantId, String(existing.rows[0].id));
      return record ? { incident: record, created: false } : null;
    }
    const user = await this.pool.query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 AND m.status = 'active'
       ORDER BY u.created_at LIMIT 1`,
      [input.tenantId],
    );
    const actorId = user.rows[0]?.id;
    if (!actorId) return null;
    const inserted = await this.pool.query(
      `INSERT INTO incidents
         (tenant_id, title, severity, source, source_ref, app_system_id, root_cause, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, title, severity, status, commander_id, source, app_system_id, root_cause, due_at`,
      [
        input.tenantId,
        input.title,
        input.severity,
        input.source,
        input.sourceRef,
        input.appSystemId ?? null,
        input.rootCause ?? null,
        actorId,
      ],
    );
    const row = inserted.rows[0];
    if (!row) return null;
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'source_ingested', $4::jsonb)`,
      [input.tenantId, row.id, actorId, JSON.stringify({ source: input.source, sourceRef: input.sourceRef })],
    );
    for (const evidence of input.evidence ?? []) {
      await this.pool.query(
        `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [input.tenantId, row.id, evidence.kind, evidence.source, evidence.summary, JSON.stringify(evidence.payload ?? {})],
      );
    }
    await this.pool.query(
      `INSERT INTO messages (tenant_id, title, body, severity)
       VALUES ($1, $2, $3, 'warning')`,
      [input.tenantId, `新事件：${input.severity}`, input.title],
    );
    return { incident: this.map(row), created: true };
  }

  private async collectConnectorEvidence(tenantId: string, incidentId: string, actorId: string): Promise<void> {
    const connectors = await this.pool.query<{
      connector_type: string;
      name: string;
      config: Record<string, unknown>;
    }>(
      `SELECT DISTINCT ON (connector_type) connector_type, name, config
       FROM connectors WHERE tenant_id = $1 AND status <> 'archived'
       ORDER BY connector_type, created_at`,
      [tenantId],
    );
    const tasks: Array<{
      connectorType: string;
      name: string;
      tool: string;
      input: Record<string, unknown>;
    }> = [];
    for (const connector of connectors.rows) {
      const diagnosticQuery = typeof connector.config.diagnosticQuery === 'string'
        ? connector.config.diagnosticQuery
        : undefined;
      let selected: { tool: string; input: Record<string, unknown> } | undefined;
      switch (connector.connector_type) {
        case 'prometheus':
          selected = { tool: 'prometheus_query', input: { query: diagnosticQuery ?? 'up' } };
          break;
        case 'zabbix':
          selected = { tool: 'zabbix_hosts', input: {} };
          break;
        case 'alertmanager':
          selected = { tool: 'alertmanager_alerts', input: {} };
          break;
        case 'clickhouse':
          if (diagnosticQuery) selected = { tool: 'clickhouse_query', input: { sql: diagnosticQuery } };
          break;
        case 'postgres':
          if (diagnosticQuery) selected = { tool: 'postgres_query', input: { sql: diagnosticQuery } };
          break;
        case 'mysql':
          if (diagnosticQuery) selected = { tool: 'mysql_query', input: { sql: diagnosticQuery } };
          break;
        default:
          break;
      }
      if (selected) {
        tasks.push({
          connectorType: connector.connector_type,
          name: connector.name,
          tool: selected.tool,
          input: selected.input,
        });
      }
    }

    const outcomes = await Promise.all(tasks.map(async (task) => {
      const tool = await this.tools.resolve(tenantId, task.tool);
      if (!tool) return { task, ok: false as const, error: 'connector_not_configured' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const result = await tool.execute(task.input, { tenantId, signal: controller.signal });
        return { task, ok: true as const, result: JSON.stringify(result).slice(0, 12000) };
      } catch (error) {
        return { task, ok: false as const, error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    }));

    for (const outcome of outcomes) {
      if (outcome.ok) {
        await this.pool.query(
          `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
           VALUES ($1, $2, 'connector_query', $3, $4, $5::jsonb)`,
          [
            tenantId,
            incidentId,
            outcome.task.connectorType,
            `${outcome.task.tool} 查询成功（${outcome.task.name}）`,
            JSON.stringify({ tool: outcome.task.tool, input: outcome.task.input, result: outcome.result }),
          ],
        );
        await this.pool.query(
          `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
           VALUES ($1, $2, $3, 'connector_evidence', $4::jsonb)`,
          [tenantId, incidentId, actorId, JSON.stringify({ tool: outcome.task.tool, source: outcome.task.connectorType })],
        );
      } else {
        await this.pool.query(
          `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
           VALUES ($1, $2, 'connector_error', $3, $4, $5::jsonb)`,
          [
            tenantId,
            incidentId,
            outcome.task.connectorType,
            `${outcome.task.tool} 查询失败（${outcome.task.name}）`,
            JSON.stringify({ tool: outcome.task.tool, error: outcome.error }),
          ],
        );
      }
    }
  }

  private async generateReport(tenantId: string, incidentId: string, actorId: string): Promise<void> {
    const existing = await this.pool.query(
      `SELECT 1 FROM incident_events
       WHERE tenant_id = $1 AND incident_id = $2 AND type = 'report_generated' LIMIT 1`,
      [tenantId, incidentId],
    );
    if (existing.rows[0]) return;
    const detail = await this.getWithEvents(tenantId, incidentId);
    const markdown = await this.report(tenantId, incidentId);
    if (!detail || !markdown) return;
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'report_generated', $4::jsonb)`,
      [tenantId, incidentId, actorId, JSON.stringify({ markdown, generatedAt: new Date().toISOString() })],
    );
    await this.pool.query(
      `INSERT INTO messages (tenant_id, title, body, severity)
       VALUES ($1, $2, $3, 'info')`,
      [
        tenantId,
        `事件报告已生成：${detail.incident.title}`,
        detail.incident.rootCause ?? '根因待确认',
      ],
    );
  }

  private async collectTopologyEvidence(
    tenantId: string,
    incidentId: string,
    actorId: string,
    appSystemId: string | null,
  ): Promise<void> {
    if (!appSystemId) return;
    const system = await this.pool.query<{ name: string; code: string }>(
      'SELECT name, code FROM app_systems WHERE tenant_id = $1 AND id = $2',
      [tenantId, appSystemId],
    );
    if (!system.rows[0]) return;
    const nodes = await this.pool.query<{
      hostname: string;
      status: string;
      applications: unknown[];
      metrics: Record<string, unknown>;
      last_seen: Date;
    }>(
      `SELECT hostname, status, applications, metrics, last_seen
       FROM agents WHERE tenant_id = $1 AND app_system_id = $2 ORDER BY hostname`,
      [tenantId, appSystemId],
    );
    const topology = nodes.rows.map((node) => ({
      hostname: node.hostname,
      status: node.status,
      applications: node.applications,
      metrics: node.metrics,
      lastSeen: node.last_seen.toISOString(),
    }));
    const appCount = topology.reduce((sum, node) => sum + node.applications.length, 0);
    const summary = `应用系统 ${system.rows[0].name}：${topology.length} 个节点，${appCount} 个应用实例；${topology.filter((node) => node.status !== 'online').length} 个节点离线`;
    await this.pool.query(
      `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
       VALUES ($1, $2, 'topology', 'opsagent', $3, $4::jsonb)`,
      [tenantId, incidentId, summary, JSON.stringify({ appSystem: system.rows[0], nodes: topology })],
    );
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'topology_collected', $4::jsonb)`,
      [tenantId, incidentId, actorId, JSON.stringify({ appSystemId, nodeCount: topology.length, appCount })],
    );
  }

  private async convergeRootCause(tenantId: string, incidentId: string, actorId: string): Promise<void> {
    const evidence = await this.pool.query<{ kind: string; payload: Record<string, unknown> }>(
      `SELECT kind, payload FROM incident_evidence
       WHERE tenant_id = $1 AND incident_id = $2`,
      [tenantId, incidentId],
    );
    const kinds = new Set(evidence.rows.map((row) => row.kind));
    const incident = await this.pool.query<{ root_cause: string | null }>(
      'SELECT root_cause FROM incidents WHERE tenant_id = $1 AND id = $2',
      [tenantId, incidentId],
    );
    let confidence = 60;
    if (incident.rows[0]?.root_cause) confidence += 10;
    if (kinds.has('host_inspection')) confidence += 15;
    if (kinds.has('connector_query')) confidence += 8;
    if (kinds.has('topology')) confidence += 5;
    if (kinds.has('log_signal')) confidence += 5;
    if (kinds.has('connector_error')) confidence -= 10;
    confidence = Math.max(40, Math.min(98, confidence));

    const topology = evidence.rows.find((row) => row.kind === 'topology')?.payload;
    const nodes = Array.isArray(topology?.nodes)
      ? topology.nodes.filter((node): node is Record<string, unknown> => typeof node === 'object' && node !== null)
      : [];
    const offlineNodes = nodes.filter((node) => node.status !== 'online');
    const downApps = nodes.flatMap((node) => Array.isArray(node.applications) ? node.applications : [])
      .filter((app): app is Record<string, unknown> => typeof app === 'object' && app !== null)
      .filter((app) => typeof app.status === 'string' && !/running|up|active|healthy/i.test(app.status));

    // Rebuild candidate hypotheses on every convergence; keep the supported primary.
    await this.pool.query(
      `DELETE FROM incident_hypotheses WHERE tenant_id = $1 AND incident_id = $2 AND status = 'candidate'`,
      [tenantId, incidentId],
    );
    const candidates: Array<{ statement: string; confidence: number; status: string }> = [];
    if (kinds.has('connector_error')) {
      candidates.push({
        statement: '连接器取证失败，监控数据可能不完整，需要检查连接器配置与凭据',
        confidence: Math.min(confidence - 10, 45),
        status: kinds.has('connector_query') ? 'rejected' : 'candidate',
      });
    }
    if (offlineNodes.length > 0) {
      candidates.push({
        statement: `应用系统存在 ${offlineNodes.length} 个离线节点，可能是节点级故障`,
        confidence: Math.min(confidence, 60),
        status: 'candidate',
      });
    } else if (kinds.has('topology')) {
      candidates.push({
        statement: '应用系统节点全部在线，可排除节点级不可用',
        confidence: 20,
        status: 'rejected',
      });
    }
    if (downApps.length > 0) {
      candidates.push({
        statement: `${downApps.length} 个应用实例状态异常，需检查应用进程与依赖`,
        confidence: Math.min(confidence, 55),
        status: 'candidate',
      });
    }
    if (!kinds.has('connector_query') && !kinds.has('connector_error')) {
      candidates.push({ statement: '缺少连接器监控证据，根因需要人工确认', confidence: 40, status: 'candidate' });
    } else if (kinds.has('connector_query')) {
      candidates.push({ statement: '连接器已返回监控证据，可排除数据缺失导致的误判', confidence: 25, status: 'rejected' });
    }

    const rootCause = incident.rows[0]?.root_cause;
    if (rootCause) {
      await this.pool.query(
        `UPDATE incident_hypotheses SET status = 'candidate'
         WHERE tenant_id = $1 AND incident_id = $2 AND status = 'supported' AND statement <> $3`,
        [tenantId, incidentId, rootCause],
      );
    }
    const hypothesis = rootCause
      ? await this.pool.query<{ id: string }>(
          `SELECT id FROM incident_hypotheses WHERE tenant_id = $1 AND incident_id = $2
           AND status = 'supported' AND statement = $3 ORDER BY created_at DESC LIMIT 1`,
          [tenantId, incidentId, rootCause],
        )
      : await this.pool.query<{ id: string }>(
          `SELECT id FROM incident_hypotheses WHERE tenant_id = $1 AND incident_id = $2
           AND status = 'supported' ORDER BY created_at DESC LIMIT 1`,
          [tenantId, incidentId],
        );
    if (hypothesis.rows[0]) {
      await this.pool.query(
        `UPDATE incident_hypotheses SET confidence = $1, status = 'supported' WHERE id = $2`,
        [confidence, hypothesis.rows[0].id],
      );
    } else if (rootCause) {
      await this.pool.query(
        `INSERT INTO incident_hypotheses (tenant_id, incident_id, statement, confidence, status)
         VALUES ($1, $2, $3, $4, 'supported')`,
        [tenantId, incidentId, rootCause, confidence],
      );
    }
    for (const candidate of candidates) {
      await this.pool.query(
        `INSERT INTO incident_hypotheses (tenant_id, incident_id, statement, confidence, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, incidentId, candidate.statement, Math.max(20, candidate.confidence), candidate.status],
      );
    }
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'root_cause_converged', $4::jsonb)`,
      [tenantId, incidentId, actorId, JSON.stringify({ confidence, evidenceKinds: [...kinds], candidates })],    );
  }

  async addAnalysis(input: {
    tenantId: string;
    incidentId: string;
    actorId: string;
    analysis: string;
    model: string;
  }): Promise<Awaited<ReturnType<IncidentService['getWithEvents']>> | null> {
    const incident = await this.get(input.tenantId, input.incidentId);
    if (!incident) return null;
    await this.pool.query(
      `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
       VALUES ($1, $2, 'ai_analysis', $3, $4, $5::jsonb)`,
      [
        input.tenantId,
        input.incidentId,
        input.model,
        input.analysis.slice(0, 800),
        JSON.stringify({ analysis: input.analysis, model: input.model }),
      ],
    );
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'commander_analysis', $4::jsonb)`,
      [input.tenantId, input.incidentId, input.actorId, JSON.stringify({ model: input.model })],
    );
    return this.getWithEvents(input.tenantId, input.incidentId);
  }

  async getReportTemplate(tenantId: string): Promise<{
    body: string;
    custom: boolean;
    updatedAt: string | null;
  }> {
    const result = await this.pool.query<{ body: string; updated_at: Date }>(
      `SELECT body, updated_at FROM incident_report_templates
       WHERE tenant_id = $1 AND name = 'default' LIMIT 1`,
      [tenantId],
    );
    const row = result.rows[0];
    return row
      ? { body: row.body, custom: true, updatedAt: row.updated_at.toISOString() }
      : { body: DEFAULT_INCIDENT_REPORT_TEMPLATE, custom: false, updatedAt: null };
  }

  async saveReportTemplate(
    tenantId: string,
    body: string,
    actorId: string,
  ): Promise<{ body: string; custom: boolean; updatedAt: string | null }> {
    const result = await this.pool.query<{ updated_at: Date }>(
      `INSERT INTO incident_report_templates (tenant_id, name, body, is_default, updated_by)
       VALUES ($1, 'default', $2, true, $3)
       ON CONFLICT (tenant_id, name) DO UPDATE
         SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING updated_at`,
      [tenantId, body, actorId],
    );
    return {
      body,
      custom: true,
      updatedAt: result.rows[0]?.updated_at.toISOString() ?? null,
    };
  }

  async flagBreachedSla(tenantId?: string): Promise<number> {
    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      created_by: string;
      title: string;
      due_at: Date;
    }>(
      `SELECT i.id, i.tenant_id, i.created_by, i.title, i.due_at FROM incidents i
       WHERE i.status NOT IN ('resolved', 'closed')
         AND i.due_at IS NOT NULL AND i.due_at < now()
         ${tenantId ? 'AND i.tenant_id = $1' : ''}
         AND NOT EXISTS (
           SELECT 1 FROM incident_events e
           WHERE e.incident_id = i.id AND e.type = 'sla_breached'
         )
       ORDER BY i.due_at ASC LIMIT 50`,
      tenantId ? [tenantId] : [],
    );
    for (const row of result.rows) {
      await this.pool.query(
        `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
         VALUES ($1, $2, $3, 'sla_breached', $4::jsonb)`,
        [row.tenant_id, row.id, row.created_by, JSON.stringify({ dueAt: row.due_at.toISOString() })],
      );
      await this.pool.query(
        `INSERT INTO messages (tenant_id, title, body, severity)
         VALUES ($1, $2, $3, 'warning')`,
        [row.tenant_id, `SLA 已逾期：${row.title}`, `应完成时间 ${row.due_at.toISOString()}，事件仍未关闭`],
      );
    }
    return result.rows.length;
  }

  async resolveRecovered(tenantId?: string): Promise<number> {
    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      created_by: string;
      title: string;
    }>(
      `SELECT i.id, i.tenant_id, i.created_by, i.title FROM incidents i
       WHERE i.status = 'open'
         AND i.source = 'agent_health'
         AND i.app_system_id IS NOT NULL
         ${tenantId ? 'AND i.tenant_id = $1' : ''}
         AND EXISTS (
           SELECT 1 FROM agents a
           WHERE a.app_system_id = i.app_system_id AND a.tenant_id = i.tenant_id
             AND a.status = 'online' AND a.last_seen > now() - interval '90 seconds'
         )
         AND NOT EXISTS (
           SELECT 1 FROM agent_events e
           JOIN agents a ON a.id = e.agent_id
           WHERE a.app_system_id = i.app_system_id AND e.status = 'open'
         )`,
      tenantId ? [tenantId] : [],
    );
    let resolved = 0;
    for (const row of result.rows) {
      await this.pool.query(
        `UPDATE incidents SET status = 'resolved', updated_at = now() WHERE id = $1`,
        [row.id],
      );
      await this.pool.query(
        `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
         VALUES ($1, $2, $3, 'auto_resolved', $4::jsonb)`,
        [row.tenant_id, row.id, row.created_by, JSON.stringify({ reason: 'all_agent_events_resolved' })],
      );
      await this.pool.query(
        `UPDATE incident_tickets SET status = 'done' WHERE tenant_id = $1 AND incident_id = $2`,
        [row.tenant_id, row.id],
      );
      await this.pool.query(
        `INSERT INTO messages (tenant_id, title, body, severity)
         VALUES ($1, $2, $3, 'info')`,
        [row.tenant_id, `事件已自动恢复：${row.title}`, '所有 Agent 异常事件已关闭，应用系统恢复在线'],
      );
      await this.generateReport(row.tenant_id, row.id, row.created_by);
      resolved += 1;
    }
    return resolved;
  }

  async report(tenantId: string, id: string): Promise<string | null> {
    const detail = await this.getWithEvents(tenantId, id);
    if (!detail) return null;
    const template = await this.getReportTemplate(tenantId);
    const segments: Record<string, string> = {
      title: detail.incident.title,
      id: detail.incident.id,
      severity: detail.incident.severity,
      status: detail.incident.status,
      source: detail.incident.source,
      rootCause: detail.incident.rootCause ?? '未确认',
      evidence: detail.evidence.length > 0
        ? detail.evidence.map((item) => `- [${item.kind}] ${item.summary}`).join('\n')
        : '- 暂无',
      hypotheses: detail.hypotheses.length > 0
        ? detail.hypotheses.map((item) => `- ${item.confidence}% ${item.status}：${item.statement}`).join('\n')
        : '- 暂无',
      tickets: detail.tickets.length > 0
        ? detail.tickets.map((item) => `- ${item.title}（${item.assignee} / ${item.status}）`).join('\n')
        : '- 暂无',
      timeline: detail.events.length > 0
        ? detail.events.map((event) => `- ${event.createdAt} ${event.type} ${JSON.stringify(event.payload)}`).join('\n')
        : '- 暂无',
      generatedAt: new Date().toISOString(),
    };
    return template.body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => segments[key] ?? match);
  }

  async requestApproval(input: {
    tenantId: string;
    incidentId: string;
    actorId: string;
    action: string;
    risk: 'R2' | 'R3';
    details?: Record<string, unknown>;
  }): Promise<Awaited<ReturnType<IncidentService['getWithEvents']>> | null> {
    const incident = await this.get(input.tenantId, input.incidentId);
    if (!incident) return null;
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO incident_approvals
         (tenant_id, incident_id, action, risk, details, requested_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
      [input.tenantId, input.incidentId, input.action, input.risk, JSON.stringify(input.details ?? {}), input.actorId],
    );
    const approvalId = inserted.rows[0]?.id;
    if (!approvalId) return null;
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, 'approval_requested', $4::jsonb)`,
      [input.tenantId, input.incidentId, input.actorId, JSON.stringify({ approvalId, action: input.action, risk: input.risk })],
    );
    await this.pool.query(
      `INSERT INTO messages (tenant_id, title, body, severity)
       VALUES ($1, $2, $3, 'warning')`,
      [input.tenantId, `事件操作待审批：${input.risk}`, input.action],
    );
    return this.getWithEvents(input.tenantId, input.incidentId);
  }

  async decideApproval(input: {
    tenantId: string;
    incidentId: string;
    approvalId: string;
    actorId: string;
    decision: 'approve' | 'deny';
    reason?: string;
  }): Promise<Awaited<ReturnType<IncidentService['getWithEvents']>> | null> {
    const updated = await this.pool.query<{ id: string }>(
      `UPDATE incident_approvals
       SET status = $1, reason = $2, decided_by = $3, decided_at = now()
       WHERE tenant_id = $4 AND incident_id = $5 AND id = $6 AND status = 'pending'
       RETURNING id`,
      [input.decision === 'approve' ? 'approved' : 'denied', input.reason ?? null, input.actorId, input.tenantId, input.incidentId, input.approvalId],
    );
    if (!updated.rows[0]) return null;
    await this.pool.query(
      `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.tenantId,
        input.incidentId,
        input.actorId,
        input.decision === 'approve' ? 'approval_approved' : 'approval_denied',
        JSON.stringify({ approvalId: input.approvalId, reason: input.reason ?? null }),
      ],
    );
    return this.getWithEvents(input.tenantId, input.incidentId);
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
    await this.collectConnectorEvidence(input.tenantId, input.id, input.actorId);
    await this.collectTopologyEvidence(input.tenantId, input.id, input.actorId, row.app_system_id);
    await this.convergeRootCause(input.tenantId, input.id, input.actorId);
    await this.generateReport(input.tenantId, input.id, input.actorId);
    if (completed) {
      await this.pool.query(
        `UPDATE incident_tickets SET status = 'done' WHERE tenant_id = $1 AND incident_id = $2`,
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
    due_at?: Date | null;
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
      dueAt: row.due_at ? row.due_at.toISOString() : null,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
