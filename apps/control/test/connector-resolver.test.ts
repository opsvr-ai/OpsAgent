import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { ConnectorService } from '../src/connectors/service.js';
import { ConnectorToolResolver } from '../src/connectors/runtime.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const demo = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('connector tool resolver', () => {
  it('loads HTTP connector tools per tenant', async () => {
    const service = new ConnectorService(pool);
    await service.create({
      tenantId: demo,
      connectorType: 'prometheus',
      name: 'resolver-prometheus',
      config: { baseUrl: 'http://prometheus.internal:9090' },
    });

    const resolver = new ConnectorToolResolver(pool);
    expect(await resolver.resolve(demo, 'prometheus_query')).toBeDefined();
    expect(await resolver.resolve(other, 'prometheus_query')).toBeUndefined();
  });
});
