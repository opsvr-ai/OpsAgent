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

describe('incident API', () => {
  it('creates, lists, and advances an incident', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/incidents',
      headers: { cookie },
      payload: { title: 'checkout latency', severity: 'P1' },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/incidents/${id}`,
      headers: { cookie },
      payload: { status: 'investigating' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ status: 'investigating' });

    const list = await app.inject({ method: 'GET', url: '/api/incidents', headers: { cookie } });
    expect(list.json()).toMatchObject([{ id, severity: 'P1' }]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/incidents/${id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ incident: { id }, events: [{}, {}] });
    await app.close();
  });

  it('rejects an invalid status', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/incidents',
      headers: { cookie },
      payload: { title: 'bad status', severity: 'P3' },
    });
    const id = (created.json() as { id: string }).id;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/incidents/${id}`,
      headers: { cookie },
      payload: { status: 'unknown' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
