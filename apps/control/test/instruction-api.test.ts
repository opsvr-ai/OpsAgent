import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
let pool: Pool;
let agentId: string;
let tenantId: string;

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
  const tenant = await pool.query<{ tenant_id: string }>(
    `SELECT m.tenant_id FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE u.username = 'tenant-admin' LIMIT 1`,
  );
  tenantId = tenant.rows[0]?.tenant_id ?? '';
  agentId = randomUUID();
  await pool.query(
    `INSERT INTO agents (id, tenant_id, name, hostname, os, arch, version, status, agent_key, last_seen, capabilities)
     VALUES ($1, $2, 'instruction-agent', 'instruction-agent', 'linux', 'amd64', '0.2.0', 'online', 'instruction-key', now(), '["inspect"]'::jsonb)`,
    [agentId, tenantId],
  );
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

describe('agent instruction API', () => {
  it('creates a read-only instruction for one target agent', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '系统运行多久了', clientRequestId: 'req-1' },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { instructionId: string; intent: { kind: string }; status: string };
    expect(body.intent.kind).toBe('inspect');
    expect(body.status).toBe('pending');

    const command = await pool.query<{ type: string; requested_by: string | null; instruction: string | null }>(
      'SELECT type, requested_by, instruction FROM agent_commands WHERE id = $1',
      [body.instructionId],
    );
    expect(command.rows[0]).toMatchObject({ type: 'agent_instruction', instruction: '系统运行多久了' });
    expect(command.rows[0]?.requested_by).not.toBeNull();

    const history = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    expect((history.json() as Array<{ instructionId: string }>).some((item) => item.instructionId === body.instructionId)).toBe(true);

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '系统运行多久了', clientRequestId: 'req-1' },
    });
    expect(repeated.statusCode).toBe(202);
    expect((repeated.json() as { instructionId: string }).instructionId).toBe(body.instructionId);
    await app.close();
  });

  it('creates one read-only instruction for each batch target', async () => {
    const secondId = randomUUID();
    await pool.query(
      `INSERT INTO agents (id, tenant_id, name, hostname, os, arch, version, status, agent_key, last_seen, capabilities)
       VALUES ($1, $2, 'batch-agent', 'batch-agent', 'linux', 'amd64', '0.2.0', 'online', 'batch-key', now(), '["inspect"]'::jsonb)`,
      [secondId, tenantId],
    );
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/instructions',
      headers: { cookie },
      payload: { agentIds: [agentId, secondId], instruction: '看看磁盘使用率' },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { instructions: Array<{ agentId: string }> };
    expect(body.instructions).toHaveLength(2);
    expect(new Set(body.instructions.map((item) => item.agentId))).toEqual(new Set([agentId, secondId]));
    await app.close();
  });

  it('rejects write instructions and offline targets', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const write = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '重启订单服务' },
    });
    expect(write.statusCode).toBe(400);
    expect((write.json() as { error: string }).error).toBe('unsupported_instruction');

    await pool.query('UPDATE agents SET last_seen = now() - interval \'10 minutes\' WHERE id = $1', [agentId]);
    const offline = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '看看磁盘' },
    });
    expect(offline.statusCode).toBe(409);
    await app.close();
  });
});
