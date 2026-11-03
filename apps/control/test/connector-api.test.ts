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
  const passwordHash = await hash('correct horse battery staple');
  await pool.query('UPDATE users SET password_hash = $1 WHERE username IN ($2, $3)', [
    passwordHash,
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

describe('connector configuration API', () => {
  it('creates and lists a tenant connector', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app, 'tenant-admin');

    const created = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: {
        connectorType: 'prometheus',
        name: 'prod-prometheus',
        config: { baseUrl: 'http://prometheus.internal:9090' },
        credentialRef: 'vault:tenants/demo/prometheus',
      },
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/connectors', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([
      { name: 'prod-prometheus', connectorType: 'prometheus', status: 'draft' },
    ]);

    await app.close();
  });

  it('denies a role without connector.configure', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'sre-dba' },
    });
    const cookie = await login(app, 'sre-dba');
    const response = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
