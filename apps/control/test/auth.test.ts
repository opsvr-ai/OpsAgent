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
  const passwordHash = await hash('correct horse battery staple');
  await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [
    passwordHash,
    'tenant-admin',
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe('local admin authentication', () => {
  it('logs in, sets a hardened cookie, and returns the tenant roles', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/local-admin',
      payload: { username: 'tenant-admin', password: 'correct horse battery staple' },
    });

    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toContain('opsagent_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookie?.split(';')[0] },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { username: 'tenant-admin' },
      tenants: [{ slug: 'tenant-demo', roles: ['tenant_admin'] }],
    });

    const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_events WHERE action = 'auth.login' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ method: 'local_admin' });
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('correct horse');

    await app.close();
  });

  it('rejects a wrong password without a session', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/local-admin',
      payload: { username: 'tenant-admin', password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('refuses local admin when disabled', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: false, username: 'tenant-admin' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/local-admin',
      payload: { username: 'tenant-admin', password: 'correct horse battery staple' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
