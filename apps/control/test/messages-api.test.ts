import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const tenant = '00000000-0000-4000-8000-000000000001';
let pool: Pool;
let userId = '';

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
  const admin = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'tenant-admin'");
  userId = admin.rows[0]?.id ?? '';
  await pool.query(
    `INSERT INTO messages (tenant_id, user_id, title, body, severity)
     VALUES ($1, $2, '巡检失败', 'Prometheus 不可达', 'warning')`,
    [tenant, userId],
  );
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

describe('messages API', () => {
  it('lists messages and marks one read', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const list = await app.inject({ method: 'GET', url: '/api/messages', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ title: '巡检失败', readAt: null }]);
    const id = (list.json() as { id: string }[])[0]?.id;
    const read = await app.inject({
      method: 'POST',
      url: `/api/messages/${id}/read`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    await app.close();
  });
});
