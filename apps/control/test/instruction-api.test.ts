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

  it('creates, lists and deletes instruction templates', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents/instruction-templates',
      headers: { cookie },
      payload: { name: '磁盘模板', instruction: '检查磁盘使用率和 inode' },
    });
    expect(created.statusCode).toBe(201);
    const template = created.json() as { id: string };
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/agents/instruction-templates/${template.id}`,
      headers: { cookie },
      payload: { name: '磁盘模板 v2', instruction: '检查磁盘、inode 和日志' },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { name: string }).name).toBe('磁盘模板 v2');
    const list = await app.inject({
      method: 'GET',
      url: '/api/agents/instruction-templates',
      headers: { cookie },
    });
    expect((list.json() as Array<{ id: string }>).some((item) => item.id === template.id)).toBe(true);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/agents/instruction-templates/${template.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
    await app.close();
  });

  it('links a completed instruction to incident evidence', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const incidentResponse = await app.inject({
      method: 'POST',
      url: '/api/incidents',
      headers: { cookie },
      payload: { title: '指令关联测试', severity: 'P2' },
    });
    const incidentId = (incidentResponse.json() as { id: string }).id;
    const created = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '检查磁盘', incidentId },
    });
    expect(created.statusCode).toBe(202);
    const instructionId = (created.json() as { instructionId: string }).instructionId;
    await pool.query(
      `UPDATE agent_commands SET status = 'completed', completed_at = now(),
         result = $2::jsonb WHERE id = $1`,
      [instructionId, JSON.stringify({ answer: '磁盘使用率 90%', evidence: { disk: 90 }, toolsUsed: ['inspect'] })],
    );
    const detail = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/instructions/${instructionId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const evidence = await pool.query<{ kind: string; summary: string }>(
      'SELECT kind, summary FROM incident_evidence WHERE incident_id = $1',
      [incidentId],
    );
    expect(evidence.rows.some((row) => row.kind === 'agent_instruction' && row.summary.includes('磁盘使用率'))).toBe(true);
    const events = await pool.query<{ type: string }>(
      'SELECT type FROM incident_events WHERE incident_id = $1',
      [incidentId],
    );
    expect(events.rows.some((row) => row.type === 'instruction_completed')).toBe(true);
    const incidentInstructions = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incidentId}/instructions`,
      headers: { cookie },
    });
    expect(incidentInstructions.statusCode).toBe(200);
    expect((incidentInstructions.json() as Array<{ answer: string }>).some((item) => item.answer.includes('磁盘使用率'))).toBe(true);
    const csv = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incidentId}/instructions.csv`,
      headers: { cookie },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('磁盘使用率');
    await app.close();
  });

  it('cancels a pending instruction', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '检查端口' },
    });
    const instructionId = (created.json() as { instructionId: string }).instructionId;
    const canceled = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions/${instructionId}/cancel`,
      headers: { cookie },
      payload: {},
    });
    expect(canceled.statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/instructions/${instructionId}`,
      headers: { cookie },
    });
    expect((detail.json() as { status: string }).status).toBe('canceled');
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

    const badIncident = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '看看磁盘', incidentId: randomUUID() },
    });
    expect(badIncident.statusCode).toBe(404);
    expect((badIncident.json() as { error: string }).error).toBe('incident_not_found');

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
