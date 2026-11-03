import Fastify, { type FastifyInstance } from 'fastify';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'opsagent-control',
  }));

  return app;
}
