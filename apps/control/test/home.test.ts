import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const otherTenant = '00000000-0000-4000-8000-000000000002';
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

describe('tenant selection and home', () => {
  it('selects a tenant and returns the role-aware home', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);

    const select = await app.inject({
      method: 'POST',
      url: `/api/tenants/${'00000000-0000-4000-8000-000000000001'}/select`,
      headers: { cookie },
    });
    expect(select.statusCode).toBe(200);

    const home = await app.inject({ method: 'GET', url: '/api/home', headers: { cookie } });
    expect(home.statusCode).toBe(200);
    expect(home.json()).toMatchObject({
      tenantId: '00000000-0000-4000-8000-000000000001',
      roleView: 'tenant_admin',
    });

    await app.close();
  });

  it('denies selecting a tenant where the user is not a member', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/tenants/${otherTenant}/select`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
