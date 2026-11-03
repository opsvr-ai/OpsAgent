import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { ScenarioService, type ToolResolver } from '../src/scenarios/service.js';
import { LongTaskService } from '../src/tasks/service.js';

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

async function waitTask(app: ReturnType<typeof buildServer>, cookie: string, status: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie } });
    const task = (list.json() as Array<{ status: string }>)[0];
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`task did not reach ${status}`);
}

describe('long task API', () => {
  it('runs a scenario in the background', async () => {
    const tools: ToolResolver = {
      async resolve(_tenantId, name) {
        return { name, risk: 'R0', execute: async () => ({ ok: true }) };
      },
    };
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      scenarioTools: tools,
    });
    const cookie = await login(app);
    const scenario = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: { cookie },
      payload: {
        name: 'task-success',
        definition: { steps: [{ name: 'check', tool: 'check', input: {} }] },
      },
    });
    const scenarioId = (scenario.json() as { id: string }).id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie },
      payload: { title: '后台巡检', scenarioId },
    });
    expect(created.statusCode).toBe(201);
    expect(await waitTask(app, cookie, 'success')).toMatchObject({ status: 'success' });
    await app.close();
  });

  it('pauses on R2 and resumes after task approval', async () => {
    const tools: ToolResolver = {
      async resolve(_tenantId, name) {
        return { name, risk: 'R2', execute: async () => ({ restarted: true }) };
      },
    };
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      scenarioTools: tools,
    });
    const cookie = await login(app);
    const scenario = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: { cookie },
      payload: {
        name: 'task-approval',
        definition: { steps: [{ name: 'restart', tool: 'restart', input: {} }] },
      },
    });
    const scenarioId = (scenario.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie },
      payload: { title: '受控重启', scenarioId },
    });
    const paused = (await waitTask(app, cookie, 'awaiting_approval')) as { id: string };
    const approved = await app.inject({
      method: 'POST',
      url: `/api/tasks/${paused.id}/approve`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'success' });
    await app.close();
  });

  it('marks interrupted running tasks as failed on recovery', async () => {
    const admin = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = 'tenant-admin'",
    );
    const scenario = await pool.query<{ id: string }>(
      `INSERT INTO scenarios (tenant_id, name, definition)
       VALUES ('00000000-0000-4000-8000-000000000001', 'recover-scenario', '{"steps":[]}'::jsonb)
       RETURNING id`,
    );
    const task = await pool.query<{ id: string }>(
      `INSERT INTO long_tasks (tenant_id, title, scenario_id, status, created_by)
       VALUES ($1, 'interrupted', $2, 'running', $3) RETURNING id`,
      ['00000000-0000-4000-8000-000000000001', scenario.rows[0]?.id, admin.rows[0]?.id],
    );
    const service = new LongTaskService(pool, new ScenarioService(pool, { resolve: async () => undefined }));
    expect(await service.recoverInterrupted()).toBeGreaterThanOrEqual(1);
    const row = await pool.query<{ status: string; error: string }>(
      'SELECT status, error FROM long_tasks WHERE id = $1',
      [task.rows[0]?.id],
    );
    expect(row.rows[0]).toMatchObject({ status: 'failed', error: 'interrupted' });
  });
});
