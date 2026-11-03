import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
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

describe('scenario publishing', () => {
  it('publishes a scenario and lists it with the published status', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: { cookie },
      payload: {
        name: 'publish-check',
        definition: { steps: [{ name: 'x', tool: 'mock.echo', input: {} }] },
      },
    });
    const id = (created.json() as { id: string }).id;

    const published = await app.inject({
      method: 'PATCH',
      url: `/api/scenarios/${id}/status`,
      headers: { cookie },
      payload: { status: 'published' },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ status: 'published' });

    const list = await app.inject({ method: 'GET', url: '/api/scenarios', headers: { cookie } });
    expect(list.json()).toMatchObject([{ id, status: 'published' }]);
    await app.close();
  });

  it('rejects an unknown status', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: { cookie },
      payload: {
        name: 'invalid-status',
        definition: { steps: [{ name: 'x', tool: 'mock.echo', input: {} }] },
      },
    });
    const id = (created.json() as { id: string }).id;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/scenarios/${id}/status`,
      headers: { cookie },
      payload: { status: 'root' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('sets a schedule interval', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: { cookie },
      payload: {
        name: 'schedule-check',
        definition: { steps: [{ name: 'x', tool: 'mock.echo', input: {} }] },
      },
    });
    const id = (created.json() as { id: string }).id;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/scenarios/${id}/schedule`,
      headers: { cookie },
      payload: { intervalMinutes: 60 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ intervalMinutes: 60 });
    await app.close();
  });
});
