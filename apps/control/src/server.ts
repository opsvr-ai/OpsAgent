import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerAuthRoutes } from './auth/routes.js';
import type { LocalAdminConfig } from './auth/local-admin.js';

export interface BuildServerOptions {
  readonly pool?: Pool;
  readonly localAdmin?: LocalAdminConfig;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'opsagent-control',
  }));

  if (options.pool) {
    app.register(cookie);
    registerAuthRoutes(app, options.pool, options.localAdmin ?? { enabled: false, username: '' });
  }

  return app;
}
