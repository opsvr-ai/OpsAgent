import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RuntimeClient } from '@opsagent/contracts';
import type { Pool } from 'pg';
import { PlatformAssistant } from '../assistant/platform.js';
import { ModelCompletionService } from '../models/completion.js';
import { ModelProviderService } from '../models/service.js';

type AgentRow = { tenant_id: string; hostname: string };
type CliEvent =
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export function registerAgentCliRoutes(
  app: FastifyInstance,
  pool: Pool,
  runtime: RuntimeClient,
  modelSecret = process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret',
): void {
  const platform = new PlatformAssistant(pool);
  const completion = new ModelCompletionService(new ModelProviderService(pool, modelSecret));
  const cliSessions = new Map<string, string>();

  async function authorize(agentId: string, key: unknown): Promise<AgentRow | null> {
    if (typeof key !== 'string') return null;
    const result = await pool.query<AgentRow>(
      'SELECT tenant_id, hostname FROM agents WHERE id = $1 AND agent_key = $2',
      [agentId, key],
    );
    return result.rows[0] ?? null;
  }

  async function ensureSession(agentId: string, tenantId: string, hostname: string): Promise<string> {
    const existing = cliSessions.get(agentId);
    if (existing) return existing;
    const user = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 AND m.status = 'active'
       ORDER BY u.created_at LIMIT 1`,
      [tenantId],
    );
    const runtimeSession = await runtime.startSession({
      tenantId,
      userId: user.rows[0]?.id ?? '00000000-0000-0000-0000-000000000000',
      roleView: `agent-cli:${hostname}`,
    });
    cliSessions.set(agentId, runtimeSession.runtimeSessionId);
    return runtimeSession.runtimeSessionId;
  }

  async function* ask(agentId: string, row: AgentRow, question: string): AsyncGenerator<CliEvent> {
    if (/^(你好|您好|hi|hello)[!！。.?\s]*$/i.test(question)) {
      yield { type: 'delta', text: `你好，我是 ${row.hostname} 上的 OpsAgent。可以问我磁盘分区、CPU/内存、进程、端口、服务、日志、应用系统健康或纳管主机等问题。` };
      yield { type: 'done' };
      return;
    }
    if (/(技能|skill|会哪些)/i.test(question)) {
      yield {
        type: 'delta',
        text: [
          `**${row.hostname}** 的 OpsAgent 已加载以下技能：`,
          '',
          '- `system-overview`：系统概况、CPU、内存、磁盘和负载',
          '- `disk-usage`：磁盘分区和可用空间',
          '- `memory-usage`：内存和 swap',
          '- `network-status`：网卡、IP、路由、DNS',
          '- `service-status`：服务和进程状态',
          '- `process-top`：进程和资源占用',
          '- `logs-recent`：最近系统日志',
          '- `container-status`：容器运行状态',
          '- `agent-health`：Agent 安装、配置和日志路径',
          '',
          '直接输入问题即可调用对应技能。',
        ].join('\n'),
      };
      yield { type: 'done' };
      return;
    }
    if (/(你能做什么|你会什么|有什么能力|能帮我做什么|使用帮助)/i.test(question)) {
      yield {
        type: 'delta',
        text: [
          `我是 **${row.hostname}** 上的 OpsAgent，可以直接对话：`,
          '',
          '- 本机检查：磁盘分区、CPU、内存、进程、端口、服务、网络、软件包、日志、Agent 部署路径',
          '- 文件与日志：查看目录、查看日志尾部、检查权限与大小',
          '- 平台数据：纳管主机统计、应用系统、主动告警',
          '- 故障分析：应用系统健康检查、跨节点异常关联、根因定位',
          '',
          '例如：「看看 /opt/opsagent/logs 目录」「当前有哪些告警」「订单中心健康情况和故障根因」。',
        ].join('\n'),
      };
      yield { type: 'done' };
      return;
    }

    let plan = await platform.detect(row.tenant_id, question);
    if (!plan && (/\/[^\s，。！？；;:：]+/.test(question) || /(磁盘|分区|内存|cpu|进程|端口|服务|日志|系统|配置|部署|路径|主机|agent|告警|性能|负载|网络|内核|时间|状态|检查|查看|看看|文件|目录|读取|巡检)/i.test(question))) {
      plan = await platform.detect(row.tenant_id, `${row.hostname} ${question}`);
    }

    let platformAnswer = '';
    if (plan) {
      yield {
        type: 'status',
        text: plan.kind === 'agent' || plan.kind === 'exec' ? '正在执行目标机只读检查…' : '正在查询平台数据…',
      };
      for await (const event of platform.execute(plan, row.tenant_id, `cli-${randomUUID()}`)) {
        if (event.type === 'assistant.delta' && event.text) platformAnswer += event.text;
        if (event.type === 'tool.call') {
          yield { type: 'status', text: `正在执行 ${event.tool}…` };
        }
      }
      if (platformAnswer && plan.kind !== 'agent' && plan.kind !== 'exec') {
        yield { type: 'delta', text: platformAnswer };
        yield { type: 'done' };
        return;
      }
    }

    const sessionId = await ensureSession(agentId, row.tenant_id, row.hostname);
    const prompt = platformAnswer
      ? [
          '你是 OpsAgent 操作系统智能体命令行助手，不是通用编码助手。',
          `当前接管主机：${row.hostname}。`,
          '下面是本机 Agent 刚刚执行的真实只读检查结果。',
          '请严格依据这些数据直接回答用户问题，保留关键数字和结论，过滤无关模块，不要编造。',
          '没有提供上次检查数据时，只描述本次结果，不要臆造前后对比。',
          '',
          '--- 检查结果开始 ---',
          platformAnswer,
          '--- 检查结果结束 ---',
          '',
          `用户问题：${question}`,
        ].join('\n')
      : [
          '你是 OpsAgent 操作系统智能体命令行助手，不是通用编码助手。',
          `当前接管主机：${row.hostname}。`,
          '回答要简洁、面向运维，可引用平台数据和本机检查结果；不要声称你能直接修改目标主机。',
          '如果用户问题明确涉及本机指标、磁盘、进程、端口、日志、服务或应用系统健康，优先使用 OpsAgent 的检查能力；日常问答则直接回答。',
          '',
          `用户问题：${question}`,
        ].join('\n');

    yield { type: 'status', text: platformAnswer ? '检查完成，正在生成结论…' : '正在调用智能体框架…' };
    let modelAnswer = '';
    let runtimeError = '';
    for await (const event of runtime.prompt(
      sessionId,
      prompt,
      `cli-${randomUUID()}`,
      { permissionMode: 'read-only' },
    )) {
      if (event.type === 'assistant.delta' && event.text) {
        modelAnswer += event.text;
        yield { type: 'delta', text: event.text };
      }
      if (event.type === 'runtime.error') runtimeError = event.message;
      if (event.type === 'session.done') break;
    }
    if (modelAnswer) {
      yield { type: 'done' };
      return;
    }
    if (!modelAnswer && prompt) {
      try {
        const answer = await completion.complete({
          tenantId: row.tenant_id,
          system: '你是 OpsAgent 操作系统智能体命令行助手。只回答运维问题，简洁、准确，不编造主机数据。',
          prompt,
          maxTokens: 1200,
        });
        if (answer.trim()) {
          yield { type: 'delta', text: answer.trim() };
          yield { type: 'done' };
          return;
        }
      } catch (caught) {
        if (!runtimeError) runtimeError = caught instanceof Error ? caught.message : String(caught);
      }
    }
    if (platformAnswer) {
      yield { type: 'delta', text: platformAnswer };
      yield { type: 'done' };
      return;
    }
    yield {
      type: 'error',
      message: runtimeError ? `模型对话暂不可用：${runtimeError}` : '智能体没有返回内容',
    };
  }

  app.post<{ Params: { id: string } }>('/api/agents/:id/explain', async (request, reply) => {
    const body = request.body as {
      agentKey?: unknown;
      question?: unknown;
      evidence?: unknown;
    } | undefined;
    if (typeof body?.question !== 'string' || typeof body.evidence !== 'object' || body.evidence === null) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const row = await authorize(request.params.id, body.agentKey);
    if (!row) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const analysis = await completion.complete({
        tenantId: row.tenant_id,
        system: [
          '你是 OpsAgent 操作系统智能体的运维分析助手。',
          '只根据给出的主机证据回答，不要输出原始命令结果，不要罗列核心信息。',
          '先给结论，再给关键依据和可执行的下一步建议；没有发现异常要明确说明。',
          '使用简体中文，控制在 300 字以内。',
        ].join('\n'),
        prompt: JSON.stringify({
          hostname: row.hostname,
          question: body.question,
          evidence: body.evidence,
        }).slice(0, 24_000),
        maxTokens: 800,
      });
      return reply.send({ analysis });
    } catch (caught) {
      request.log.warn({ err: caught, agentId: row.hostname }, 'agent explain failed');
      return reply.code(503).send({ error: 'model_unavailable' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/chat', async (request, reply) => {
    const body = request.body as { agentKey?: unknown; question?: unknown } | undefined;
    if (typeof body?.question !== 'string') return reply.code(400).send({ error: 'invalid_request' });
    const question = body.question.trim();
    if (!question || question.length > 4000) return reply.code(400).send({ error: 'invalid_question' });
    const row = await authorize(request.params.id, body.agentKey);
    if (!row) return reply.code(401).send({ error: 'unauthorized' });

    let answer = '';
    let error = '';
    try {
      for await (const event of ask(request.params.id, row, question)) {
        if (event.type === 'delta') answer += event.text;
        if (event.type === 'error') error = event.message;
      }
    } catch (caught) {
      console.error('agent cli chat failed', caught);
      if (!answer) {
        return reply.code(500).send({
          error: 'cli_chat_failed',
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
    return reply.send({
      supported: Boolean(answer),
      hostname: row.hostname,
      answer: answer || error,
    });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/chat/stream', async (request, reply) => {
    const body = request.body as { agentKey?: unknown; question?: unknown } | undefined;
    if (typeof body?.question !== 'string') return reply.code(400).send({ error: 'invalid_request' });
    const question = body.question.trim();
    if (!question || question.length > 4000) return reply.code(400).send({ error: 'invalid_question' });
    const row = await authorize(request.params.id, body.agentKey);
    if (!row) return reply.code(401).send({ error: 'unauthorized' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders?.();
    const send = (event: CliEvent): void => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      for await (const event of ask(request.params.id, row, question)) {
        if (event.type === 'delta' && event.text) {
          const characters = Array.from(event.text);
          for (let index = 0; index < characters.length; index += 32) {
            send({ type: 'delta', text: characters.slice(index, index + 32).join('') });
            if (characters.length > 32) await sleep(12);
          }
        } else {
          send(event);
        }
      }
    } catch (caught) {
      console.error('agent cli stream failed', caught);
      send({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) });
    }
    reply.raw.end();
  });
}
