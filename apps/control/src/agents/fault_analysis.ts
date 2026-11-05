import type { Pool } from 'pg';
import { AgentCommandService } from './commands.js';
import { ModelCompletionService } from '../models/completion.js';
import { ModelProviderService } from '../models/service.js';

interface AnalysisRow {
  id: string;
  tenant_id: string;
  app_system_id: string | null;
  app_system_name: string;
  title: string;
  status: string;
  trigger_event_id: string | null;
  trigger_agent_id: string | null;
  summary: string;
  root_cause: string;
  confidence: string;
  findings: unknown;
  evidence: Record<string, unknown>;
  created_at: Date;
  completed_at: Date | null;
}

interface FollowUp {
  hostname?: string;
  question?: string;
}

export class FaultAnalysisService {
  private readonly commands: AgentCommandService;
  private readonly completion: ModelCompletionService;

  constructor(
    private readonly pool: Pool,
    modelSecret = process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret',
  ) {
    this.commands = new AgentCommandService(pool);
    this.completion = new ModelCompletionService(new ModelProviderService(pool, modelSecret));
  }

  async triggerForEvent(agentId: string, eventId: string): Promise<string | null> {
    const agent = await this.pool.query<{ tenant_id: string; app_system_id: string | null }>(
      'SELECT tenant_id, app_system_id FROM agents WHERE id = $1',
      [agentId],
    );
    const row = agent.rows[0];
    if (!row?.app_system_id) return null;
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM fault_analyses
       WHERE tenant_id = $1 AND app_system_id = $2 AND status IN ('pending', 'running')
       ORDER BY created_at DESC LIMIT 1`,
      [row.tenant_id, row.app_system_id],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const system = await this.pool.query<{ name: string }>(
      'SELECT name FROM app_systems WHERE id = $1',
      [row.app_system_id],
    );
    const analysis = await this.pool.query<{ id: string }>(
      `INSERT INTO fault_analyses
         (tenant_id, app_system_id, app_system_name, title, status, trigger_event_id, trigger_agent_id)
       VALUES ($1, $2, $3, $4, 'running', $5, $6) RETURNING id`,
      [
        row.tenant_id,
        row.app_system_id,
        system.rows[0]?.name ?? '应用系统',
        `故障定界分析 · ${system.rows[0]?.name ?? '应用系统'}`,
        eventId,
        agentId,
      ],
    );
    const id = analysis.rows[0]?.id;
    if (!id) return null;
    void this.run(id).catch((error) => {
      console.error('[fault] analysis failed', id, error);
    });
    return id;
  }

  async triggerForAppSystem(tenantId: string, appSystemId: string, userId?: string): Promise<string> {
    const system = await this.pool.query<{ name: string }>(
      'SELECT name FROM app_systems WHERE tenant_id = $1 AND id = $2',
      [tenantId, appSystemId],
    );
    if (!system.rows[0]) throw new Error('app_system_not_found');
    const analysis = await this.pool.query<{ id: string }>(
      `INSERT INTO fault_analyses
         (tenant_id, app_system_id, app_system_name, title, status, created_by)
       VALUES ($1, $2, $3, $4, 'running', $5) RETURNING id`,
      [tenantId, appSystemId, system.rows[0].name, `故障定界分析 · ${system.rows[0].name}`, userId ?? null],
    );
    const id = analysis.rows[0]?.id;
    if (!id) throw new Error('fault_analysis_create_failed');
    void this.run(id).catch((error) => console.error('[fault] analysis failed', id, error));
    return id;
  }

  async list(tenantId: string): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT id, app_system_id, app_system_name, title, status, summary, root_cause,
              confidence, trigger_event_id, created_at, completed_at
       FROM fault_analyses WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [tenantId],
    );
    return result.rows;
  }

  async get(tenantId: string, id: string): Promise<unknown | null> {
    const result = await this.pool.query<AnalysisRow>(
      `SELECT * FROM fault_analyses WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const steps = await this.pool.query(
      `SELECT id, seq, type, title, detail, status, payload, created_at
       FROM fault_analysis_steps WHERE tenant_id = $1 AND analysis_id = $2 ORDER BY seq`,
      [tenantId, id],
    );
    return {
      id: row.id,
      appSystemId: row.app_system_id,
      appSystemName: row.app_system_name,
      title: row.title,
      status: row.status,
      summary: row.summary,
      rootCause: row.root_cause,
      confidence: Number(row.confidence),
      findings: row.findings,
      evidence: row.evidence,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      steps: steps.rows.map((step) => ({
        ...step,
        createdAt: (step.created_at as Date).toISOString(),
      })),
    };
  }

  private async run(analysisId: string): Promise<void> {
    const analysisResult = await this.pool.query<AnalysisRow>(
      'SELECT * FROM fault_analyses WHERE id = $1',
      [analysisId],
    );
    const analysis = analysisResult.rows[0];
    if (!analysis?.app_system_id) return;
    const tenants = analysis.tenant_id;
    const agents = await this.pool.query<{
      id: string; hostname: string; status: string; metrics: Record<string, unknown>; last_seen: Date;
    }>(
      `SELECT id, hostname, status, metrics, last_seen FROM agents
       WHERE tenant_id = $1 AND app_system_id = $2 ORDER BY hostname`,
      [tenants, analysis.app_system_id],
    );
    const events = await this.pool.query<{
      agent_id: string; title: string; detail: string; severity: string; detected_at: Date;
    }>(
      `SELECT e.agent_id, e.title, e.detail, e.severity, e.detected_at
       FROM agent_events e JOIN agents a ON a.id = e.agent_id
       WHERE e.tenant_id = $1 AND a.app_system_id = $2 AND e.status = 'open'
       ORDER BY e.detected_at DESC LIMIT 50`,
      [tenants, analysis.app_system_id],
    );
    await this.step(analysisId, 1, 'collect', '汇总应用系统异常与指标', `收集 ${agents.rows.length} 个节点、${events.rows.length} 条异常`);
    const context = {
      appSystem: analysis.app_system_name,
      nodes: agents.rows.map((agent) => ({
        hostname: agent.hostname,
        status: agent.status,
        lastSeen: agent.last_seen.toISOString(),
        metrics: agent.metrics,
      })),
      events: events.rows.map((event) => ({
        hostname: agents.rows.find((agent) => agent.id === event.agent_id)?.hostname ?? '',
        title: event.title,
        detail: event.detail,
        severity: event.severity,
        detectedAt: event.detected_at.toISOString(),
      })),
    };
    let decision: {
      rootCause?: string; confidence?: number; summary?: string;
      findings?: unknown[]; followUp?: FollowUp[];
    } = {};
    try {
      const answer = await this.completion.complete({
        tenantId: tenants,
        system: [
          '你是 OpsAgent 故障定界分析器。',
          '根据应用系统的节点指标和异常事件，判断故障根因和影响范围。',
          '如果需要更多证据，返回 followUp 数组，最多 3 项，每项包含 hostname 和 question。',
          '只返回 JSON，不要 Markdown：{"rootCause":"","confidence":0.8,"summary":"","findings":[{"title":"","detail":"","severity":"warning"}],"followUp":[{"hostname":"","question":""}]}',
        ].join('\n'),
        prompt: JSON.stringify(context),
        maxTokens: 1200,
      });
      decision = this.parseDecision(answer);
    } catch {
      decision = this.fallbackDecision(context);
    }
    const followUps = (decision.followUp ?? []).slice(0, 3);
    const evidence: Array<Record<string, unknown>> = [];
    for (const [index, followUp] of followUps.entries()) {
      const target = agents.rows.find((agent) => agent.hostname === followUp.hostname);
      if (!target || typeof followUp.question !== 'string') continue;
      await this.step(analysisId, 10 + index, 'dispatch', `调度 ${target.hostname} 补充数据`, followUp.question);
      const command = await this.commands.create({
        tenantId: tenants,
        agentId: target.id,
        type: 'inspect',
        input: { question: followUp.question },
      });
      if (!command) continue;
      let current = command;
      for (let attempt = 0; attempt < 20 && !['completed', 'failed'].includes(current.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = (await this.commands.get(tenants, target.id, command.id)) ?? current;
      }
      const payload = typeof current.result === 'object' && current.result !== null
        ? current.result as Record<string, unknown>
        : {};
      evidence.push({
        hostname: target.hostname,
        question: followUp.question,
        status: current.status,
        analysis: payload.analysis ?? '',
        answer: payload.answer ?? '',
      });
      await this.step(analysisId, 20 + index, 'evidence', `${target.hostname} 补充数据返回`, String(payload.analysis ?? payload.answer ?? ''), current.status);
    }
    if (evidence.length > 0) {
      await this.step(analysisId, 30, 'synthesize', '综合补充证据重新分析', `合并 ${evidence.length} 份补充证据`);
      try {
        const answer = await this.completion.complete({
          tenantId: tenants,
          system: '你是 OpsAgent 总调度智能体。根据初始分析和补充证据，给出最终根因、影响范围和处置建议。使用简体中文，简洁。',
          prompt: JSON.stringify({ context, initial: decision, evidence }).slice(0, 24_000),
          maxTokens: 1200,
        });
        decision = { ...decision, summary: answer, rootCause: decision.rootCause || answer };
      } catch {
        // Keep the initial decision.
      }
    }
    const findings = Array.isArray(decision.findings) ? decision.findings : this.fallbackFindings(context.events);
    const rootCause = decision.rootCause || '根据现有证据未形成确定根因，建议继续观察异常节点。';
    const summary = decision.summary || `应用系统 ${analysis.app_system_name} 共 ${agents.rows.length} 个节点，${events.rows.length} 条异常。`;
    await this.pool.query(
      `UPDATE fault_analyses SET status = 'completed', summary = $3, root_cause = $4,
         confidence = $5, findings = $6::jsonb, evidence = $7::jsonb, completed_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [
        analysisId, tenants, summary, rootCause,
        Math.min(Math.max(Number(decision.confidence ?? 0.6), 0), 1),
        JSON.stringify(findings), JSON.stringify({ context, followUps, evidence }),
      ],
    );
    await this.step(analysisId, 40, 'result', '故障定界完成', rootCause);
  }

  private parseDecision(answer: string): {
    rootCause?: string; confidence?: number; summary?: string;
    findings?: unknown[]; followUp?: FollowUp[];
  } {
    try {
      const start = answer.indexOf('{');
      const end = answer.lastIndexOf('}');
      if (start < 0 || end <= start) return {};
      return JSON.parse(answer.slice(start, end + 1)) as {
        rootCause?: string; confidence?: number; summary?: string;
        findings?: unknown[]; followUp?: FollowUp[];
      };
    } catch {
      return { summary: answer };
    }
  }

  private fallbackDecision(context: {
    nodes: Array<{ hostname: string; status: string; metrics: Record<string, unknown> }>;
    events: Array<{ hostname: string; title: string; detail: string; severity: string }>;
  }): {
    rootCause: string; confidence: number; summary: string;
    findings: unknown[]; followUp: FollowUp[];
  } {
    const affected = new Set(context.events.map((event) => event.hostname));
    const offline = context.nodes.filter((node) => node.status !== 'online').map((node) => node.hostname);
    const rootCause = context.events.length > 0
      ? `${context.events[0]?.title ?? '应用异常'}：${context.events[0]?.detail ?? ''}；影响 ${affected.size} 个节点。`
      : offline.length > 0 ? `节点离线：${offline.join('、')}` : '未发现明确异常。';
    return {
      rootCause,
      confidence: context.events.length > 0 ? 0.55 : 0.3,
      summary: `应用系统共 ${context.nodes.length} 个节点，${context.events.length} 条异常。`,
      findings: context.events.map((event) => ({ title: event.title, detail: event.detail, severity: event.severity })),
      followUp: context.events.slice(0, 2).map((event) => ({
        hostname: event.hostname,
        question: `结合当前异常，检查相关进程、端口和最近日志：${event.title}`,
      })),
    };
  }

  private fallbackFindings(events: Array<{ title: string; detail: string; severity: string }>): unknown[] {
    return events.map((event) => ({ title: event.title, detail: event.detail, severity: event.severity }));
  }

  private async step(
    analysisId: string,
    seq: number,
    type: string,
    title: string,
    detail: string,
    status = 'completed',
  ): Promise<void> {
    const analysis = await this.pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM fault_analyses WHERE id = $1',
      [analysisId],
    );
    const tenantId = analysis.rows[0]?.tenant_id;
    if (!tenantId) return;
    await this.pool.query(
      `INSERT INTO fault_analysis_steps (tenant_id, analysis_id, seq, type, title, detail, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, analysisId, seq, type, title, detail.slice(0, 8000), status],
    );
  }
}
