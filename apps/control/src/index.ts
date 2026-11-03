import { Pool } from 'pg';
import { buildServer } from './server.js';
import { ConnectorToolResolver } from './connectors/runtime.js';
import { ScenarioService } from './scenarios/service.js';
import { ScenarioScheduler } from './scenarios/scheduler.js';
import { DshHeadlessGenerator } from './studio/dsh-generator.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent',
});
const tools = new ConnectorToolResolver(pool);

const app = buildServer({
  pool,
  localAdmin: {
    enabled: process.env.LOCAL_ADMIN_ENABLED === 'true',
    username: process.env.LOCAL_ADMIN_USERNAME ?? 'tenant-admin',
  },
  scenarioTools: tools,
  ...(process.env.STUDIO_DSH_ENABLED === 'false'
    ? {}
    : { studioGenerator: new DshHeadlessGenerator() }),
});
const scheduler = new ScenarioScheduler(new ScenarioService(pool, tools));

await app.listen({ host: '0.0.0.0', port });
scheduler.start();
console.log(`opsagent-control listening on :${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void app.close().then(() => pool.end());
  });
}
