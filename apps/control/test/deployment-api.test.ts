import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { getCommandSigner } from '../src/agents/signing.js';

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

describe('release and deployment API', () => {
  it('verifies a signed release and records canary approval/rollback', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const signer = getCommandSigner();
    const manifest = {
      appSystemId: null,
      version: '1.2.3',
      artifactUrl: 'https://artifacts.example/order-1.2.3.tgz',
      sha256: 'a'.repeat(64),
    };
    const signed = signer.sign(manifest);
    const release = await app.inject({
      method: 'POST',
      url: '/api/releases',
      headers: { cookie },
      payload: { ...manifest, signature: signed.signature },
    });
    expect(release.statusCode).toBe(201);
    const releaseId = (release.json() as { id: string }).id;

    const deployment = await app.inject({
      method: 'POST',
      url: '/api/deployments',
      headers: { cookie },
      payload: { releaseId, environment: 'staging', strategy: 'canary', canaryPercent: 10 },
    });
    expect(deployment.statusCode).toBe(201);
    const deploymentId = (deployment.json() as { id: string }).id;
    expect(deployment.json()).toMatchObject({ status: 'pending', strategy: 'canary', canaryPercent: 10 });

    const approved = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deploymentId}/decision`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved' });

    const rolledBack = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deploymentId}/rollback`,
      headers: { cookie },
      payload: { reason: 'canary error budget exceeded' },
    });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json()).toMatchObject({ status: 'rolled_back' });
    await app.close();
  });

  it('rejects a release with an invalid signature', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
    });
    const cookie = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/releases',
      headers: { cookie },
      payload: {
        version: '9.9.9',
        artifactUrl: 'https://artifacts.example/bad.tgz',
        sha256: 'b'.repeat(64),
        signature: 'invalid',
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
