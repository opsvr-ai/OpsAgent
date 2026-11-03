import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
  await pool.query('UPDATE users SET password_hash = $1 WHERE username IN ($2, $3)', [
    await hash('correct horse battery staple'),
    'platform-admin',
    'tenant-admin',
  ]);
});

afterAll(async () => {
  await pool.end();
});

async function login(app: ReturnType<typeof buildServer>, username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/local-admin',
    payload: { username, password: 'correct horse battery staple' },
  });
  const cookie = response.headers['set-cookie'];
  if (typeof cookie !== 'string') throw new Error('missing cookie');
  return cookie.split(';')[0] ?? '';
}

describe('platform tenant API', () => {
  it('lets a platform admin list and create tenants', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'platform-admin' },
    });
    const cookie = await login(app, 'platform-admin');
    const list = await app.inject({
      method: 'GET',
      url: '/api/platform/tenants',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[]).length).toBeGreaterThan(0);

    const created = await app.inject({
      method: 'POST',
      url: '/api/platform/tenants',
      headers: { cookie },
      payload: { name: 'New Tenant', slug: 'new-tenant' },
    });
    expect(created.statusCode).toBe(201);
    await app.close();
  });

  it('denies a tenant admin', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app, 'tenant-admin');
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/tenants',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
