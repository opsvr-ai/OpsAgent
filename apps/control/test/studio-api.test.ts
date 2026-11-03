import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import type { StudioGenerator } from '../src/studio/service.js';

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

describe('studio creation workflow', () => {
  it('generates, submits, and approves a bundle', async () => {
    const generator: StudioGenerator = {
      async generate(input) {
        return { goal: input.goal, files: ['cordis.patch.yml', 'src/index.ts'], manifest: {} };
      },
    };
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      studioGenerator: generator,
    });
    const cookie = await login(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/studio/sessions',
      headers: { cookie },
      payload: { goal: 'connect blueking cmdb', platform: 'blueking' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'generated' });
    const id = (created.json() as { id: string }).id;

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/studio/sessions/${id}/submit`,
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ status: 'pending_review' });

    const reviewed = await app.inject({
      method: 'POST',
      url: `/api/studio/sessions/${id}/review`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({ status: 'approved' });

    const list = await app.inject({ method: 'GET', url: '/api/studio/sessions', headers: { cookie } });
    expect(list.json()).toHaveLength(1);
    await app.close();
  });

  it('does not submit without a generated bundle', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/studio/sessions',
      headers: { cookie },
      payload: { goal: 'no generator', platform: 'unknown' },
    });
    const id = (created.json() as { id: string }).id;
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/studio/sessions/${id}/submit`,
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(409);
    await app.close();
  });
});
