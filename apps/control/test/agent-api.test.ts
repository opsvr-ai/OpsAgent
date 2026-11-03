import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const tenant = '00000000-0000-4000-8000-000000000001';
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

describe('agent registry API', () => {
  it('registers, heartbeats and lists an agent', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      agentEnrollmentToken: 'enroll',
    });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/agents/register',
      headers: { 'x-opsagent-enrollment-token': 'enroll' },
      payload: {
        tenantId: tenant,
        name: 'prod-host-1',
        hostname: 'prod-host-1',
        os: 'linux',
        arch: 'amd64',
        version: '0.1.0',
        capabilities: ['cpu', 'disk'],
      },
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json() as { agent: { id: string }; agentKey: string };

    const heartbeat = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/heartbeat`,
      payload: { agentKey: body.agentKey, metrics: { cpuCores: 8, heapMB: 3 } },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({ metrics: { cpuCores: 8, heapMB: 3 } });

    const cookie = await login(app);
    const command = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/commands`,
      headers: { cookie },
      payload: { type: 'diagnostics' },
    });
    expect(command.statusCode).toBe(201);
    const commandId = (command.json() as { id: string }).id;

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/commands`,
      headers: { cookie },
      payload: { type: 'rm_rf' },
    });
    expect(invalid.statusCode).toBe(400);

    const pending = await app.inject({
      method: 'GET',
      url: `/api/agents/${body.agent.id}/commands/pending?agentKey=${body.agentKey}`,
    });
    expect(pending.json()).toMatchObject({ id: commandId, type: 'diagnostics' });

    const completed = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/commands/${commandId}/complete`,
      payload: { agentKey: body.agentKey, result: { ok: true } },
    });
    expect(completed.json()).toMatchObject({ status: 'completed' });

    const list = await app.inject({ method: 'GET', url: '/api/agents', headers: { cookie } });
    expect(list.json()).toMatchObject([{ hostname: 'prod-host-1', status: 'online' }]);
    await app.close();
  });

  it('rejects registration without the enrollment token', async () => {
    const app = buildServer({ pool, agentEnrollmentToken: 'enroll' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/register',
      payload: { tenantId: tenant },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
