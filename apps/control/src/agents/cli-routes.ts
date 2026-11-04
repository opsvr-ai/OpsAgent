import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RuntimeClient } from '@opsagent/contracts';
import type { Pool } from 'pg';
import { PlatformAssistant } from '../assistant/platform.js';

export function registerAgentCliRoutes(app: FastifyInstance, pool: Pool, runtime: RuntimeClient): void {
  const platform = new PlatformAssistant(pool);
  const cliSessions = new Map<string, string>();

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

  async function askRuntime(sessionId: string, prompt: string): Promise<{ answer: string; error: string }> {
    const chunks: string[] = [];
    let error = '';
    for await (const event of runtime.prompt(
      sessionId,
      prompt,
      `cli-${randomUUID()}`,
      { permissionMode: 'read-only' },
    )) {
      if (event.type === 'assistant.delta' && event.text) chunks.push(event.text);
      if (event.type === 'runtime.error') error = event.message;
    }
    return { answer: chunks.join('').trim(), error };
  }

  app.post<{ Params: { id: string } }>('/api/agents/:id/chat', async (request, reply) => {
    const body = request.body as { agentKey?: unknown; question?: unknown } | undefined;
    if (typeof body?.agentKey !== 'string' || typeof body?.question !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const question = body.question.trim();
    if (!question || question.length > 4000) {
      return reply.code(400).send({ error: 'invalid_question' });
    }
    const agent = await pool.query<{ tenant_id: string; hostname: string }>(
      'SELECT tenant_id, hostname FROM agents WHERE id = $1 AND agent_key = $2',
      [request.params.id, body.agentKey],
    );
    const row = agent.rows[0];
    if (!row) return reply.code(401).send({ error: 'unauthorized' });

    if (/^(你好|您好|hi|hello)[!！。.?\s]*$/i.test(question)) {
      return reply.send({
        supported: true,
        hostname: row.hostname,
        answer: `你好，我是 ${row.hostname} 上的 OpsAgent。可以问我磁盘分区、CPU/内存、进程、端口、服务、日志、应用系统健康或纳管主机等问题。`,
      });
    }

    if (/(你能做什么|你会什么|有什么能力|能帮我做什么|使用帮助)/i.test(question)) {
      return reply.send({
        supported: true,
        hostname: row.hostname,
        answer: [
          `我是 **${row.hostname}** 上的 OpsAgent，可以直接对话：`,
          '',
          '- 本机检查：磁盘分区、CPU、内存、进程、端口、服务、网络、软件包、日志、Agent 部署路径',
          '- 平台数据：纳管主机统计、应用系统、主动告警',
          '- 故障分析：应用系统健康检查、跨节点异常关联、根因定位',
          '- 服务端会下发只读检查命令，由本机常驻 Agent 执行',
          '',
          '例如：「磁盘分区什么样」「当前有哪些告警」「订单中心健康情况和故障根因」。',
        ].join('\n'),
      });
    }

    let plan = await platform.detect(row.tenant_id, question);
    if (!plan && (/\/[^\s，。！？；;:：]+/.test(question) || /(磁盘|分区|内存|cpu|进程|端口|服务|日志|系统|配置|部署|路径|主机|agent|告警|性能|负载|网络|内核|时间|状态|检查|查看|看看|文件|目录|读取|巡检)/i.test(question))) {
      plan = await platform.detect(row.tenant_id, `${row.hostname} ${question}`);
    }
    let platformAnswer = '';
    if (plan) {
      const sessionId = `cli-${randomUUID()}`;
      const chunks: string[] = [];
      for await (const event of platform.execute(plan, row.tenant_id, sessionId)) {
        if (event.type === 'assistant.delta' && event.text) chunks.push(event.text);
      }
      platformAnswer = chunks.join('').trim();
      if (platformAnswer && plan.kind !== 'agent' && plan.kind !== 'exec') {
        return reply.send({ supported: true, hostname: row.hostname, answer: platformAnswer });
      }
    }

    try {
      const runtimeSessionId = await ensureSession(request.params.id, row.tenant_id, row.hostname);
      const prompt = platformAnswer
        ? [
            '你是 OpsAgent 操作系统智能体命令行助手，不是通用编码助手。',
            `当前接管主机：${row.hostname}。`,
            '下面是本机 Agent 刚刚执行的真实只读检查结果。',
            '请严格依据这些数据直接回答用户问题，保留关键数字和结论，过滤无关模块，不要编造。',
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
      const result = await askRuntime(runtimeSessionId, prompt);
      if (result.answer) {
        return reply.send({ supported: true, hostname: row.hostname, answer: result.answer });
      }
      if (platformAnswer) {
        return reply.send({ supported: true, hostname: row.hostname, answer: platformAnswer });
      }
      return reply.send({
        supported: false,
        hostname: row.hostname,
        answer: result.error ? `模型对话暂不可用：${result.error}` : '',
      });
    } catch (error) {
      console.error('agent cli chat failed', error);
      if (platformAnswer) {
        return reply.send({ supported: true, hostname: row.hostname, answer: platformAnswer });
      }
      return reply.code(500).send({
        error: 'cli_chat_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
