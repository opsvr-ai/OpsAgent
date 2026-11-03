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
    'tenant-admin',
    'sre-dba',
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

describe('audit API', () => {
  it('lists audit events for a user with audit.read', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app, 'tenant-admin');
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=10',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{ action: 'auth.login' }]);
    await app.close();
  });

  it('denies a role without audit.read', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'sre-dba' },
    });
    const cookie = await login(app, 'sre-dba');
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
