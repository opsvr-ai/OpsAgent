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
        discovery: {
          system: { osName: 'Rocky Linux', ip: '10.0.0.1' },
          applications: [{ name: 'order-service', kind: 'systemd' }],
          agent: { version: '0.2.0' },
        },
      },
    });
    expect(registered.statusCode).toBe(201);
    const body = registered.json() as {
      agent: { id: string; systemInfo: { osName: string }; applications: unknown[] };
      agentKey: string;
      commandPublicKey: string;
    };
    expect(body.agent.systemInfo.osName).toBe('Rocky Linux');
    expect(body.agent.applications).toHaveLength(1);
    expect(body.commandPublicKey.length).toBeGreaterThan(20);

    const heartbeat = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/heartbeat`,
      payload: { agentKey: body.agentKey, metrics: { cpuCores: 8, heapMB: 3 } },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({
      metrics: { cpuCores: 8, heapMB: 3 },
      commandKeyId: expect.any(String),
      commandPublicKeys: [{ keyId: expect.any(String), publicKey: expect.any(String) }],
    });

    const appSystem = await pool.query<{ id: string }>(
      `INSERT INTO app_systems (tenant_id, code, name)
       VALUES ($1, 'test-app', '测试应用')
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [tenant],
    );
    if (appSystem.rows[0]) {
      await pool.query('UPDATE agents SET app_system_id = $1 WHERE id = $2', [appSystem.rows[0].id, body.agent.id]);
    }

    const reported = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/events`,
      payload: {
        agentKey: body.agentKey,
        events: [{
          fingerprint: 'disk-low',
          severity: 'warning',
          title: '磁盘可用空间不足',
          detail: '根分区可用空间低于阈值',
          metric: { diskFreePct: 8 },
        }],
        diagnostics: {
          metrics: { diskFreeGB: 2, diskTotalGB: 100 },
          applicationLogs: { 'order-service.log': 'ERROR order-service No space left on device' },
        },
      },
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toMatchObject({ events: [{ fingerprint: 'disk-low', status: 'open' }] });

    const cookie = await login(app);
    const health = await app.inject({
      method: 'GET',
      url: '/api/app-systems/health',
      headers: { cookie },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject([{
      appSystemName: expect.any(String),
      rootCause: expect.stringContaining('磁盘可用空间不足'),
    }]);
    const incident = await pool.query<{ title: string; source: string; root_cause: string }>(
      `SELECT title, source, root_cause FROM incidents
       WHERE tenant_id = $1 AND source = 'agent_health' ORDER BY created_at DESC LIMIT 1`,
      [tenant],
    );
    expect(incident.rows[0]).toMatchObject({
      source: 'agent_health',
      root_cause: expect.stringContaining('磁盘可用空间不足'),
    });
    const evidence = await pool.query('SELECT 1 FROM incident_evidence WHERE incident_id = (SELECT id FROM incidents WHERE source = $1 LIMIT 1)', ['agent_health']);
    expect(evidence.rowCount).toBeGreaterThan(0);

    const cli = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/chat`,
      payload: { agentKey: body.agentKey, question: '当前纳管了多少操作系统智能体？' },
    });
    expect(cli.statusCode).toBe(200);
    expect(cli.json()).toMatchObject({
      supported: true,
      answer: expect.stringContaining('纳管'),
    });

    const capabilities = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/chat`,
      payload: { agentKey: body.agentKey, question: '你能做什么' },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      supported: true,
      answer: expect.stringContaining('OpsAgent'),
    });

    const stream = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/chat/stream`,
      payload: { agentKey: body.agentKey, question: '你能做什么' },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('event: delta');
    expect(stream.body).toContain('event: done');
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

    const ai = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/commands`,
      headers: { cookie },
      payload: { type: 'ai_diagnose' },
    });
    expect(ai.statusCode).toBe(201);

    const pending = await app.inject({
      method: 'GET',
      url: `/api/agents/${body.agent.id}/commands/pending?agentKey=${body.agentKey}`,
    });
    expect(pending.json()).toMatchObject({
      id: commandId,
      type: 'diagnostics',
      signedPayload: expect.any(String),
      signature: expect.any(String),
    });

    const completed = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent.id}/commands/${commandId}/complete`,
      payload: { agentKey: body.agentKey, result: { ok: true } },
    });
    expect(completed.json()).toMatchObject({ status: 'completed' });

    const list = await app.inject({ method: 'GET', url: '/api/agents', headers: { cookie } });
    expect(list.json()).toMatchObject([{ hostname: 'prod-host-1', status: 'online' }]);

    const fleet = await app.inject({ method: 'GET', url: '/api/agents/fleet', headers: { cookie } });
    expect(fleet.statusCode).toBe(200);
    expect(fleet.json()).toMatchObject({
      total: 1,
      summary: { total: 1, applications: 1, discovered: 1 },
      items: [{ hostname: 'prod-host-1', applications: [{ name: 'order-service' }] }],
      alerts: [{ fingerprint: 'disk-low', severity: 'warning' }],
    });

    const detail = await app.inject({ method: 'GET', url: `/api/agents/${body.agent.id}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ hostname: 'prod-host-1', discoveryAt: expect.any(String) });
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
