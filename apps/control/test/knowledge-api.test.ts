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

describe('knowledge API', () => {
  it('creates, searches and publishes a document', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      headers: { cookie },
      payload: { title: 'MySQL 连接池排查', body: '检查 max_connections 与等待队列' },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const search = await app.inject({
      method: 'GET',
      url: '/api/knowledge?q=连接池',
      headers: { cookie },
    });
    expect(search.json()).toMatchObject([{ id, status: 'draft' }]);

    const published = await app.inject({
      method: 'POST',
      url: `/api/knowledge/${id}/publish`,
      headers: { cookie },
    });
    expect(published.json()).toMatchObject({ status: 'published' });
    await app.close();
  });
});
