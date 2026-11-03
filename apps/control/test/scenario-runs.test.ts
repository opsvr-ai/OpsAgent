import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const tools: ToolResolver = {
  resolve(_tenantId, name) {
    if (name !== 'mock.echo') return undefined;
    return { name, risk: 'R0', execute: async (input) => ({ echoed: input.text }) };
  },
};

describe('scenario run history', () => {
  it('lists runs and returns a run report', async () => {
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
        name: 'history-check',
        definition: { steps: [{ name: 'echo', tool: 'mock.echo', input: { text: 'hi' } }] },
      },
    });
    const scenarioId = (created.json() as { id: string }).id;
    const run = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${scenarioId}/run`,
      headers: { cookie },
      payload: {},
    });
    expect(run.statusCode).toBe(200);

    const runs = await app.inject({
      method: 'GET',
      url: `/api/scenarios/${scenarioId}/runs`,
      headers: { cookie },
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toMatchObject([{ status: 'success' }]);

    const runId = (runs.json() as { id: string }[])[0]?.id;
    const report = await app.inject({
      method: 'GET',
      url: `/api/scenario-runs/${runId}`,
      headers: { cookie },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ status: 'success', results: [{ echoed: 'hi' }] });
    await app.close();
  });
});
