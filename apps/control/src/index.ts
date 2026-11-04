import { Pool } from 'pg';
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
});
const scheduler = new ScenarioScheduler(new ScenarioService(pool, tools));
const commanderScheduler = new CommanderScheduler(
  pool,
  new IncidentService(pool, tools),
  Number.parseInt(process.env.OPSAGENT_COMMANDER_INTERVAL_MS ?? '20000', 10),
  Number.parseInt(process.env.OPSAGENT_COMMANDER_RECHECK_MS ?? '900000', 10),
);
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
scheduler.start();
commanderScheduler.start();
console.log(`opsagent-control listening on :${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    scheduler.stop();
    commanderScheduler.stop();
    clearInterval(retentionTimer);
    void app.close().then(() => pool.end());
  });
}
