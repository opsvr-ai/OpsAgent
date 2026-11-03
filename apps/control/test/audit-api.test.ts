import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { AuditService } from '../src/audit/service.js';

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

  it('exports audit events as CSV', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app, 'tenant-admin');
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit/export',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('createdAt,action,result');
    expect(response.body).toContain('auth.login');
    await app.close();
  });

  it('purges audit events older than the retention window', async () => {
    await pool.query(
      `INSERT INTO audit_events (tenant_id, actor_id, action, result, created_at)
       VALUES ($1, NULL, 'old.event', 'success', now() - interval '200 days')`,
      ['00000000-0000-4000-8000-000000000001'],
    );
    const removed = await new AuditService(pool).purgeOlderThan(180);
    expect(removed).toBeGreaterThanOrEqual(1);
    const old = await pool.query("SELECT 1 FROM audit_events WHERE action = 'old.event'");
    expect(old.rowCount).toBe(0);
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
