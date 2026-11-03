import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
let pool: Pool;
const tenantId = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
  await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [
    await hash('correct horse battery staple'),
    'tenant-admin',
  ]);
});

afterAll(async () => {
  await pool.end();
});

async function login(app: ReturnType<typeof buildServer>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/local-admin',
    payload: { username: 'tenant-admin', password: 'correct horse battery staple' },
  });
  const cookie = response.headers['set-cookie'];
  if (typeof cookie !== 'string') throw new Error('missing cookie');
  return cookie.split(';')[0] ?? '';
}

describe('data store API', () => {
  it('reports stats and cleans up expired snapshots', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    await pool.query(
      `INSERT INTO data_snapshots (tenant_id, tool, cache_key, payload, bytes, created_at)
       VALUES ($1, 'promql_query', 'k1', '{"ok":true}', 10, now() - interval '40 days')`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO data_snapshots (tenant_id, tool, cache_key, payload, bytes)
       VALUES ($1, 'promql_query', 'k2', '{"ok":true}', 20)`,
      [tenantId],
    );

    const stats = await app.inject({ method: 'GET', url: '/api/data-store', headers: { cookie } });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toMatchObject({ count: 2, bytes: 30 });

    const settings = await app.inject({
      method: 'GET',
      url: '/api/data-store/settings',
      headers: { cookie },
    });
    expect(settings.json()).toMatchObject({ retentionDays: 30, priority: 'local-first' });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/data-store/settings',
      headers: { cookie },
      payload: {
        priority: 'live-first',
        syncInterval: '10m',
        fullSyncAt: '03:00',
        freshnessSec: 120,
        retentionDays: 7,
      },
    });
    expect(saved.json()).toMatchObject({ priority: 'live-first', retentionDays: 7 });

    const dryRun = await app.inject({
      method: 'POST',
      url: '/api/data-store/cleanup',
      headers: { cookie },
      payload: { beforeDays: 30, dryRun: true },
    });
    expect(dryRun.json()).toMatchObject({ count: 1, bytes: 10, dryRun: true });

    const removed = await app.inject({
      method: 'POST',
      url: '/api/data-store/cleanup',
      headers: { cookie },
      payload: { beforeDays: 30, dryRun: false },
    });
    expect(removed.json()).toMatchObject({ count: 1, bytes: 10, dryRun: false });
    const remaining = await pool.query('SELECT count(*)::int AS count FROM data_snapshots');
    expect(remaining.rows[0]?.count).toBe(1);
    await app.close();
  });
});
