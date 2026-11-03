import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { ConnectorToolResolver } from '../src/connectors/runtime.js';

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

describe('connector credentials', () => {
  it('stores credentials encrypted and resolves them for tools', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      modelSecret: 'test-secret',
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: { connectorType: 'postgres', name: 'pg-secret', config: {} },
    });
    const id = (created.json() as { id: string }).id;

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/connectors/${id}/credentials`,
      headers: { cookie },
      payload: { credentials: { connectionString: 'postgres://localhost/none' } },
    });
    expect(saved.statusCode).toBe(200);

    const row = await pool.query<{ encrypted_payload: string }>(
      'SELECT encrypted_payload FROM connector_credentials WHERE connector_id = $1',
      [id],
    );
    expect(row.rows[0]?.encrypted_payload).not.toContain('postgres://localhost/none');

    const resolver = new ConnectorToolResolver(pool, 'test-secret');
    expect(await resolver.resolve('00000000-0000-4000-8000-000000000001', 'postgres_query')).toBeDefined();
    await app.close();
  });
});
