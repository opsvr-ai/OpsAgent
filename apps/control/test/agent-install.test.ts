import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
let pool: Pool;
let distDir: string;

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
  distDir = mkdtempSync(join(tmpdir(), 'opsagent-dist-'));
  writeFileSync(join(distDir, 'opsagent-agent-linux-amd64'), 'linux-binary');
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

describe('agent install API', () => {
  it('returns one-line install commands and scripts', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      agentEnrollmentToken: 'enroll-secret',
      agentDistDir: distDir,
      agentPublicUrl: 'https://opsagent.example',
    });
    const cookie = await login(app);

    const command = await app.inject({
      method: 'GET',
      url: '/api/agents/install-command?os=linux',
      headers: { cookie },
    });
    expect(command.statusCode).toBe(200);
    expect(command.json()).toMatchObject({ os: 'linux' });
    expect((command.json() as { command: string }).command).toContain(
      'https://opsagent.example/api/agents/install.sh',
    );

    const script = await app.inject({
      method: 'GET',
      url: '/api/agents/install.sh?tenantId=tenant-1&token=enroll-secret',
    });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain('systemctl enable --now opsagent-agent');

    const powershell = await app.inject({
      method: 'GET',
      url: '/api/agents/install.ps1?tenantId=tenant-1&token=enroll-secret',
    });
    expect(powershell.statusCode).toBe(200);
    expect(powershell.body).toContain('schtasks /Create');

    const binary = await app.inject({
      method: 'GET',
      url: '/api/agents/binary?os=linux&arch=amd64&token=enroll-secret',
    });
    expect(binary.statusCode).toBe(200);
    expect(binary.body).toBe('linux-binary');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/agents/install.sh?tenantId=tenant-1&token=wrong',
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it('requires an enrollment token to expose install metadata', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      agentDistDir: distDir,
    });
    const cookie = await login(app);
    const command = await app.inject({
      method: 'GET',
      url: '/api/agents/install-command?os=linux',
      headers: { cookie },
    });
    expect(command.statusCode).toBe(503);
    await app.close();
  });
});
