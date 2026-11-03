import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { ProbeRegistry } from '../src/connectors/probe.js';

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

describe('connector health probe', () => {
  it('probes and updates connector status', async () => {
    const probes = new ProbeRegistry();
    probes.register('prometheus', {
      async probe() {
        return { ok: true, latencyMs: 12 };
      },
    });
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      connectorProbes: probes,
    });
    const cookie = await login(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: {
        connectorType: 'prometheus',
        name: 'probe-prometheus',
        config: { baseUrl: 'http://prometheus.internal:9090' },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const tested = await app.inject({
      method: 'POST',
      url: `/api/connectors/${id}/test`,
      headers: { cookie },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ status: 'healthy', latencyMs: 12 });

    const row = await pool.query<{ status: string }>('SELECT status FROM connectors WHERE id = $1', [id]);
    expect(row.rows[0]?.status).toBe('healthy');
    await app.close();
  });

  it('returns 501 when no probe is registered for the type', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      connectorProbes: new ProbeRegistry(),
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: {
        connectorType: 'unknown',
        name: 'unknown-connector',
        config: {},
      },
    });
    const id = (created.json() as { id: string }).id;
    const tested = await app.inject({
      method: 'POST',
      url: `/api/connectors/${id}/test`,
      headers: { cookie },
    });
    expect(tested.statusCode).toBe(501);
    await app.close();
  });
});
