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

describe('member roles API', () => {
  it('lists members and updates a role set', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const list = await app.inject({ method: 'GET', url: '/api/members', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const members = list.json() as Array<{ userId: string; username: string }>;
    const sre = members.find((member) => member.username === 'sre-dba');
    expect(sre).toBeDefined();

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/members/${sre?.userId}/roles`,
      headers: { cookie },
      payload: { roleIds: ['dba', 'sre_duty'] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ roles: ['dba', 'sre_duty'] });
    await app.close();
  });

  it('refuses to remove the last tenant admin', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const list = await app.inject({ method: 'GET', url: '/api/members', headers: { cookie } });
    const admin = (list.json() as Array<{ userId: string; username: string }>).find(
      (member) => member.username === 'tenant-admin',
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/members/${admin?.userId}/roles`,
      headers: { cookie },
      payload: { roleIds: [] },
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });
});
