import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { ModelProviderService } from '../src/models/service.js';
import { decryptSecret, encryptSecret } from '../src/secrets/crypto.js';

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

describe('model provider configuration', () => {
  it('encrypts the API key and never returns it', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      modelSecret: 'test-secret',
    });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/models',
      headers: { cookie },
      payload: {
        name: 'deepseek-prod',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKey: 'sk-secret',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain('sk-secret');

    const row = await pool.query<{ api_key_encrypted: string }>(
      'SELECT api_key_encrypted FROM model_providers LIMIT 1',
    );
    expect(decryptSecret(row.rows[0]?.api_key_encrypted ?? '', 'test-secret')).toBe('sk-secret');

    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie } });
    expect(list.json()).toMatchObject([{ name: 'deepseek-prod', provider: 'deepseek' }]);

    const available = await app.inject({ method: 'GET', url: '/api/models/available', headers: { cookie } });
    expect(available.statusCode).toBe(200);
    expect(available.json()).toMatchObject([{ name: 'deepseek-prod', provider: 'deepseek' }]);

    const batch = await app.inject({
      method: 'POST',
      url: '/api/models/batch',
      headers: { cookie },
      payload: {
        name: '内网模型',
        provider: 'openai',
        baseUrl: 'https://llm.example/v1',
        models: ['qwen-72b', 'qwen-32b'],
        apiKey: 'sk-batch',
      },
    });
    expect(batch.statusCode).toBe(201);
    expect((batch.json() as unknown[]).length).toBe(2);
    const batchIds = (batch.json() as Array<{ id: string }>).map((item) => item.id);
    for (const id of batchIds) {
      await app.inject({ method: 'DELETE', url: `/api/models/${id}`, headers: { cookie } });
    }

    const tenant = await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM model_providers WHERE id = $1',
      [(created.json() as { id: string }).id],
    );
    const service = new ModelProviderService(pool, 'test-secret');
    const resolved = await service.resolve(tenant.rows[0]?.tenant_id ?? '', (created.json() as { id: string }).id);
    expect(resolved?.model).toBe('deepseek-chat');

    const createdId = (created.json() as { id: string }).id;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/models/${createdId}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
    await app.close();
  });

  it('round-trips AES-GCM', () => {
    const payload = encryptSecret('hello', 'key');
    expect(payload).not.toContain('hello');
    expect(decryptSecret(payload, 'key')).toBe('hello');
  });
});
