import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerAuthRoutes } from './auth/routes.js';
import type { LocalAdminConfig } from './auth/local-admin.js';
import type { LdapAuthenticator } from './auth/ldap.js';
import { PgAuditWriter } from './audit/writer.js';
import { registerTenantRoutes } from './tenancy/routes.js';
import { registerRuntimeRoutes } from './runtime/routes.js';
import { FakeRuntime } from './runtime/fake.js';
import type { RuntimeClient } from '@opsagent/contracts';
import { registerConnectorRoutes } from './connectors/routes.js';
import { ProbeRegistry } from './connectors/probe.js';
import { createDefaultProbeRegistry } from './connectors/http-probes.js';
import { registerScenarioRoutes } from './scenarios/routes.js';
import type { ToolResolver } from './scenarios/service.js';
import { registerAuditRoutes } from './audit/routes.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { registerStudioRoutes } from './studio/routes.js';
import type { StudioGenerator } from './studio/service.js';
import { registerIncidentRoutes } from './incidents/routes.js';
import { registerDeploymentRoutes } from './deployments/routes.js';
import { registerInternalApprovalRoutes } from './internal/approvals.js';
import { registerKnowledgeRoutes } from './knowledge/routes.js';
import { registerMessageRoutes } from './messages/routes.js';
import { registerAgentRoutes } from './agents/routes.js';
import { registerAgentCliRoutes } from './agents/cli-routes.js';
import { registerAgentInstallRoutes } from './agents/install.js';
import { registerMemberRoutes } from './members/routes.js';
import { registerModelRoutes } from './models/routes.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { registerDataStoreRoutes } from './data-store/routes.js';

export interface BuildServerOptions {
  readonly pool?: Pool;
  readonly localAdmin?: LocalAdminConfig;
  readonly ldap?: LdapAuthenticator;
  readonly connectorProbes?: ProbeRegistry;
  readonly scenarioTools?: ToolResolver;
  readonly studioGenerator?: StudioGenerator;
  readonly runtime?: RuntimeClient;
  readonly internalToken?: string;
  readonly agentEnrollmentToken?: string;
  readonly agentDistDir?: string;
  readonly agentPublicUrl?: string;
  readonly modelSecret?: string;
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
    const runtime = options.runtime ?? new FakeRuntime();
    registerRuntimeRoutes(app, options.pool, audit, runtime);
    registerConnectorRoutes(
      app,
      options.pool,
      audit,
      options.connectorProbes ?? createDefaultProbeRegistry(),
      options.modelSecret ?? process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret',
    );
    const scenarioTools = options.scenarioTools ?? { resolve: async () => undefined };
    registerScenarioRoutes(
      app,
      options.pool,
      audit,
      scenarioTools,
    );
    registerTaskRoutes(app, options.pool, audit, scenarioTools);
    registerAuditRoutes(app, options.pool);
    registerInternalApprovalRoutes(app, options.pool, options.internalToken);
    registerKnowledgeRoutes(app, options.pool, audit);
    registerMessageRoutes(app, options.pool);
    registerAgentRoutes(app, options.pool, options.agentEnrollmentToken);
    registerAgentCliRoutes(app, options.pool, runtime);
    registerAgentInstallRoutes(app, options.pool, options.agentEnrollmentToken, {
      distDir: options.agentDistDir ?? 'agents/opsagent-agent/dist',
      ...(options.agentPublicUrl ? { publicUrl: options.agentPublicUrl } : {}),
    });
    registerMemberRoutes(app, options.pool, audit);
    registerModelRoutes(app, options.pool, audit, options.modelSecret ?? process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret');
    registerPlatformRoutes(app, options.pool);
    registerDataStoreRoutes(app, options.pool, audit);
    registerStudioRoutes(app, options.pool, audit, options.studioGenerator);
    registerIncidentRoutes(app, options.pool, audit, options.internalToken, runtime);
    registerDeploymentRoutes(app, options.pool, audit);
  }

  return app;
}
