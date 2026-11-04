import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AgentCaService } from './ca.js';

export function registerAgentCertificateRoutes(app: FastifyInstance, pool: Pool): void {
  let caPromise: Promise<AgentCaService | null> | undefined;

  app.post<{ Params: { id: string } }>('/api/agents/:id/certificate', async (request, reply) => {
    const body = request.body as { agentKey?: unknown; csr?: unknown } | undefined;
    if (typeof body?.agentKey !== 'string' || typeof body.csr !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (body.csr.length > 16_384) return reply.code(400).send({ error: 'csr_too_large' });
    const agent = await pool.query<{ certificate_revoked_at: Date | null }>(
      'SELECT certificate_revoked_at FROM agents WHERE id = $1 AND agent_key = $2',
      [request.params.id, body.agentKey],
    );
    if (!agent.rows[0]) return reply.code(401).send({ error: 'unauthorized' });
    if (agent.rows[0].certificate_revoked_at) {
      return reply.code(403).send({ error: 'agent_certificate_revoked' });
    }
    caPromise ??= AgentCaService.fromEnv();
    const ca = await caPromise;
    if (!ca) return reply.code(503).send({ error: 'ca_not_configured' });
    try {
      const issued = await ca.issue(body.csr);
      return reply.code(201).send(issued);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_csr',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
