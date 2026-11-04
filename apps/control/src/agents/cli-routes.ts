import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { PlatformAssistant } from '../assistant/platform.js';

export function registerAgentCliRoutes(app: FastifyInstance, pool: Pool): void {
  const platform = new PlatformAssistant(pool);

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

    if (/^(你好|您好|hi|hello|help)[!！。.?\s]*$/i.test(question)) {
      return reply.send({
        supported: true,
        hostname: row.hostname,
        answer: `你好，我是 ${row.hostname} 上的 OpsAgent。可以问我磁盘分区、CPU/内存、进程、端口、服务、日志、应用系统健康或纳管主机等问题。`,
      });
    }

    let plan = await platform.detect(row.tenant_id, question);
    if (!plan) {
      plan = await platform.detect(row.tenant_id, `${row.hostname} ${question}`);
    }
    if (!plan) {
      return reply.send({ supported: false, hostname: row.hostname, answer: '' });
    }

    const sessionId = `cli-${randomUUID()}`;
    const chunks: string[] = [];
    for await (const event of platform.execute(plan, row.tenant_id, sessionId)) {
      if (event.type === 'assistant.delta' && event.text) chunks.push(event.text);
    }
    const answer = chunks.join('').trim();
    return reply.send({ supported: Boolean(answer), hostname: row.hostname, answer });
  });
}
