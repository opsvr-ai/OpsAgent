import { Pool } from 'pg';
import { buildServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent',
});

const app = buildServer({
  pool,
  localAdmin: {
    enabled: process.env.LOCAL_ADMIN_ENABLED === 'true',
    username: process.env.LOCAL_ADMIN_USERNAME ?? 'tenant-admin',
  },
});

await app.listen({ host: '0.0.0.0', port });
console.log(`opsagent-control listening on :${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}
