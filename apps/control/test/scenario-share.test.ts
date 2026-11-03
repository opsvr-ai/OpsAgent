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

describe('scenario sharing', () => {
  it('requests and approves a tenant share', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      headers: { cookie },
      payload: {
        name: 'share-check',
        definition: { steps: [{ name: 'x', tool: 'mock.echo', input: {} }] },
      },
    });
    const scenarioId = (created.json() as { id: string }).id;

    const requested = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${scenarioId}/share`,
      headers: { cookie },
      payload: { scope: 'tenant' },
    });
    expect(requested.statusCode).toBe(201);
    const shareId = (requested.json() as { id: string }).id;

    const shares = await app.inject({ method: 'GET', url: '/api/shares', headers: { cookie } });
    expect(shares.json()).toMatchObject([{ id: shareId, status: 'pending', scope: 'tenant' }]);

    const reviewed = await app.inject({
      method: 'POST',
      url: `/api/shares/${shareId}/review`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({ status: 'approved' });

    const scenario = await app.inject({
      method: 'GET',
      url: `/api/scenarios/${scenarioId}/runs`,
      headers: { cookie },
    });
    expect(scenario.statusCode).toBe(200);
    await app.close();
  });
});
