import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { ConnectorService } from '../src/connectors/service.js';
import { ConnectorToolResolver } from '../src/connectors/runtime.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const demo = '00000000-0000-4000-8000-000000000001';
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

describe('connector driver resolver', () => {
  it('resolves DB/Redis/SSH tools without opening connections', async () => {
    const service = new ConnectorService(pool);
    const base = { tenantId: demo };
    await service.create({ ...base, connectorType: 'postgres', name: 'pg', config: { connectionString: 'postgres://localhost/none' } });
    await service.create({ ...base, connectorType: 'mysql', name: 'my', config: { url: 'mysql://localhost/none' } });
    await service.create({ ...base, connectorType: 'redis', name: 'rd', config: { url: 'redis://localhost:1' } });
    await service.create({
      ...base,
      connectorType: 'ssh',
      name: 'sh',
      config: { host: '127.0.0.1', username: 'nobody' },
    });

    const resolver = new ConnectorToolResolver(pool);
    expect(await resolver.resolve(demo, 'postgres_query')).toBeDefined();
    expect(await resolver.resolve(demo, 'mysql_query')).toBeDefined();
    expect(await resolver.resolve(demo, 'redis_read')).toBeDefined();
    expect(await resolver.resolve(demo, 'ssh_read')).toBeDefined();
  });
});
