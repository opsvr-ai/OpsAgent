import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerAuthRoutes } from './auth/routes.js';
import type { LocalAdminConfig } from './auth/local-admin.js';
import type { LdapAuthenticator } from './auth/ldap.js';
import { PgAuditWriter } from './audit/writer.js';
import { registerTenantRoutes } from './tenancy/routes.js';
import { registerRuntimeRoutes } from './runtime/routes.js';
import { registerConnectorRoutes } from './connectors/routes.js';
import { ProbeRegistry } from './connectors/probe.js';
import { createDefaultProbeRegistry } from './connectors/http-probes.js';
import { registerScenarioRoutes } from './scenarios/routes.js';
import type { ToolResolver } from './scenarios/service.js';

export interface BuildServerOptions {
  readonly pool?: Pool;
  readonly localAdmin?: LocalAdminConfig;
  readonly ldap?: LdapAuthenticator;
  readonly connectorProbes?: ProbeRegistry;
  readonly scenarioTools?: ToolResolver;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'opsagent-control',
  }));

  if (options.pool) {
    app.register(cookie);
    const audit = new PgAuditWriter(options.pool);
    registerAuthRoutes(
      app,
      options.pool,
      options.localAdmin ?? { enabled: false, username: '' },
      audit,
      options.ldap,
    );
    registerTenantRoutes(app, options.pool, audit);
    registerRuntimeRoutes(app, options.pool, audit);
    registerConnectorRoutes(
      app,
      options.pool,
      audit,
      options.connectorProbes ?? createDefaultProbeRegistry(),
    );
    registerScenarioRoutes(
      app,
      options.pool,
      audit,
      options.scenarioTools ?? { resolve: () => undefined },
    );
  }

  return app;
}
