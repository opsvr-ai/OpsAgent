import { afterAll, describe, expect, it } from 'vitest';
import {
  createPostgresQuery,
  createRedisClient,
} from '../src/connectors/drivers.js';
import { createPostgresConnector } from '../src/connectors/postgres.js';
import { createRedisConnector } from '../src/connectors/redis.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe.runIf(process.env.RUN_INTEGRATION === '1')('live drivers', () => {
  const query = createPostgresQuery(databaseUrl);
  const redis = createRedisClient(redisUrl);

  afterAll(async () => {
    await query.close();
    await redis.close();
  });

  it('runs a read-only PostgreSQL query through the connector', async () => {
    const tool = createPostgresConnector({ query }).tools[0];
    const result = (await tool?.execute({ sql: 'SELECT 1 AS ok' }, { tenantId: 't' })) as {
      rows: Array<{ ok: number }>;
    };
    expect(result.rows[0]?.ok).toBe(1);
  });

  it('reads Redis INFO through the connector', async () => {
    const tool = createRedisConnector({ client: redis }).tools[0];
    const result = await tool?.execute({ command: 'info' }, { tenantId: 't' });
    expect(String(result)).toContain('redis_version');
  });
});
