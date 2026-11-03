import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import type { ToolResolver } from '../src/scenarios/service.js';

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

describe('scenario API', () => {
  it('creates and runs a scenario with a resolved tool', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tools: ToolResolver = {
      resolve(name) {
        if (name !== 'mock.echo') return undefined;
        return { name, risk: 'R0', execute };
      },
    };
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      scenarioTools: tools,
    });
    const cookie = await login(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: { cookie },
      payload: {
        name: 'demo-check',
        description: 'demo',
        definition: {
          steps: [{ name: 'echo', tool: 'mock.echo', input: { text: 'hello' } }],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const run = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${id}/run`,
      headers: { cookie },
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ status: 'success' });
    expect(execute).toHaveBeenCalledOnce();

    const list = await app.inject({ method: 'GET', url: '/api/scenarios', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    await app.close();
  });

  it('fails a run when a tool cannot be resolved', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      scenarioTools: { resolve: () => undefined },
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: { cookie },
      payload: {
        name: 'missing-tool',
        definition: { steps: [{ name: 'x', tool: 'missing', input: {} }] },
      },
    });
    const id = (created.json() as { id: string }).id;
    const run = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${id}/run`,
      headers: { cookie },
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ status: 'failed' });
    await app.close();
  });
});
