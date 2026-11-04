import { Pool } from 'pg';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildServer } from './server.js';
import { ConnectorToolResolver } from './connectors/runtime.js';
import { ScenarioService } from './scenarios/service.js';
import { ScenarioScheduler } from './scenarios/scheduler.js';
import { DshHeadlessGenerator } from './studio/dsh-generator.js';
import { DshRuntime } from './runtime/dsh.js';
import { ModelProviderService } from './models/service.js';
import { AuditService } from './audit/service.js';
import { LongTaskService } from './tasks/service.js';
import { IncidentService } from './incidents/service.js';
import { CommanderScheduler } from './incidents/commander.js';
import { AgentKeyMonitor } from './agents/key_monitor.js';
import { DeploymentService } from './deployments/service.js';
import { DeploymentMonitor } from './deployments/monitor.js';
import { AgentResourceMonitor } from './agents/resource_monitor.js';
import { AgentCaService } from './agents/ca.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent',
});
pool.on('error', (error) => {
  console.error('postgres pool error', error.message);
});
const tools = new ConnectorToolResolver(pool);
const modelService = new ModelProviderService(
  pool,
  process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret',
);

const app = buildServer({
  pool,
  localAdmin: {
    enabled: process.env.LOCAL_ADMIN_ENABLED === 'true',
    username: process.env.LOCAL_ADMIN_USERNAME ?? 'tenant-admin',
    usernames: (process.env.LOCAL_ADMIN_USERNAMES ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  },
  scenarioTools: tools,
  ...(process.env.DSH_RUNTIME_ENABLED === 'false'
    ? {}
    : { runtime: new DshRuntime(undefined, (tenantId) => modelService.resolve(tenantId)) }),
  ...(process.env.OPSAGENT_INTERNAL_TOKEN
    ? { internalToken: process.env.OPSAGENT_INTERNAL_TOKEN }
    : {}),
  ...(process.env.OPSAGENT_AGENT_ENROLLMENT_TOKEN
    ? { agentEnrollmentToken: process.env.OPSAGENT_AGENT_ENROLLMENT_TOKEN }
    : {}),
  agentDistDir: process.env.OPSAGENT_AGENT_DIST_DIR ?? 'agents/opsagent-agent/dist',
  ...(process.env.OPSAGENT_PUBLIC_URL ? { agentPublicUrl: process.env.OPSAGENT_PUBLIC_URL } : {}),
  ...(process.env.STUDIO_DSH_ENABLED === 'false'
    ? {}
    : { studioGenerator: new DshHeadlessGenerator(undefined, modelService) }),
  ...(process.env.OPSAGENT_DESKTOP_UPDATE_DIR
    ? { desktopUpdateDir: process.env.OPSAGENT_DESKTOP_UPDATE_DIR }
    : {}),
});
const scheduler = new ScenarioScheduler(new ScenarioService(pool, tools));
const commanderScheduler = new CommanderScheduler(
  pool,
  new IncidentService(pool, tools),
  Number.parseInt(process.env.OPSAGENT_COMMANDER_INTERVAL_MS ?? '20000', 10),
  Number.parseInt(process.env.OPSAGENT_COMMANDER_RECHECK_MS ?? '900000', 10),
);
const keyMonitor = new AgentKeyMonitor(pool);
const deploymentMonitor = new DeploymentMonitor(pool, new DeploymentService(pool));
const resourceMonitor = new AgentResourceMonitor(pool);
const auditRetention = new AuditService(pool);
const taskService = new LongTaskService(pool, new ScenarioService(pool, tools));
void taskService.recoverInterrupted().catch((error) => {
  console.error('long task recovery failed', error);
});
const retentionTimer = setInterval(() => {
  void auditRetention.purgeOlderThan(180).catch((error) => {
    console.error('audit retention failed', error);
  });
}, 24 * 60 * 60 * 1000);
retentionTimer.unref();
void auditRetention.purgeOlderThan(180).catch(() => undefined);

await app.listen({ host: '0.0.0.0', port });
let tlsServer: ReturnType<typeof createServer> | undefined;
const tlsPort = Number.parseInt(process.env.OPSAGENT_TLS_PORT ?? '0', 10);
let tlsCertFile = process.env.OPSAGENT_TLS_CERT;
let tlsKeyFile = process.env.OPSAGENT_TLS_KEY;
let tlsCaFile = process.env.OPSAGENT_TLS_CA;
if (tlsPort > 0 && (!tlsCertFile || !tlsKeyFile) && process.env.OPSAGENT_TLS_AUTO !== 'false') {
  try {
    const ca = await AgentCaService.fromEnv();
    if (ca) {
      const directory = process.env.OPSAGENT_TLS_DIR ?? '.opsagent-ca';
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const dnsNames = (process.env.OPSAGENT_TLS_HOSTNAMES ?? 'localhost').split(',').map((item) => item.trim()).filter(Boolean);
      const ipAddresses = (process.env.OPSAGENT_TLS_IPS ?? '127.0.0.1').split(',').map((item) => item.trim()).filter(Boolean);
      const server = await ca.issueServer(dnsNames, ipAddresses);
      tlsCertFile = join(directory, 'server.pem');
      tlsKeyFile = join(directory, 'server-key.pem');
      tlsCaFile = join(directory, 'ca.pem');
      writeFileSync(tlsCertFile, server.certificate, { mode: 0o600 });
      writeFileSync(tlsKeyFile, server.privateKey, { mode: 0o600 });
      writeFileSync(tlsCaFile, ca.caCertificate, { mode: 0o600 });
      console.log(`opsagent-control generated internal TLS certificate expires=${server.expiresAt}`);
    }
  } catch (error) {
    console.error('internal TLS certificate generation failed', error);
  }
}
if (tlsPort > 0 && tlsCertFile && tlsKeyFile) {
  const ca = tlsCaFile ? readFileSync(tlsCaFile) : undefined;
  const requireClientCert = process.env.OPSAGENT_TLS_REQUIRE_CLIENT_CERT !== 'false';
  const handler = app.server.listeners('request')[0] as
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | undefined;
  if (handler) {
    tlsServer = createServer({
      key: readFileSync(tlsKeyFile),
      cert: readFileSync(tlsCertFile),
      ...(ca ? { ca } : {}),
      requestCert: requireClientCert,
      rejectUnauthorized: requireClientCert,
    }, handler);
    await new Promise<void>((resolve) => tlsServer?.listen(tlsPort, '0.0.0.0', resolve));
    console.log(`opsagent-control TLS listening on :${tlsPort}`);
  }
}
scheduler.start();
commanderScheduler.start();
keyMonitor.start();
deploymentMonitor.start();
resourceMonitor.start();
console.log(`opsagent-control listening on :${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    scheduler.stop();
    commanderScheduler.stop();
    keyMonitor.stop();
    deploymentMonitor.stop();
    resourceMonitor.stop();
    clearInterval(retentionTimer);
    tlsServer?.close();
    void app.close().then(() => pool.end());
  });
}
