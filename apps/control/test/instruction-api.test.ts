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
    const writeBatch = await app.inject({
      method: 'POST',
      url: '/api/agents/instructions',
      headers: { cookie },
      payload: { agentIds: [agentId, secondId], instruction: '重启 nginx 服务' },
    });
    expect(writeBatch.statusCode).toBe(202);
    const writeBody = writeBatch.json() as { approvals: Array<{ approvalId: string }> };
    expect(writeBody.approvals).toHaveLength(2);
    const approvals = await app.inject({
      method: 'GET',
      url: '/api/agent-instruction-approvals',
      headers: { cookie },
    });
    const approvalIds = new Set((approvals.json() as Array<{ id: string }>).map((item) => item.id));
    expect(writeBody.approvals.every((item) => approvalIds.has(item.approvalId))).toBe(true);

    const batchDecision = await app.inject({
      method: 'POST',
      url: '/api/agent-instruction-approvals/batch-decision',
      headers: { cookie },
      payload: { approvalIds: writeBody.approvals.map((item) => item.approvalId), decision: 'approve' },
    });
    expect(batchDecision.statusCode).toBe(200);
    expect((batchDecision.json() as { results: Array<{ statusCode: number }> }).results.every((item) => item.statusCode === 202)).toBe(true);
    await app.close();
  });

  it('creates, lists and deletes instruction templates', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents/instruction-templates',
      headers: { cookie },
      payload: { name: '磁盘模板', instruction: '检查磁盘使用率和 inode', scope: 'private' },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { scope: string }).scope).toBe('private');
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
    const report = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incidentId}/report`,
      headers: { cookie },
    });
    expect(report.statusCode).toBe(200);
    expect(report.body).toContain('Agent 排查指令');
    expect(report.body).toContain('磁盘使用率');
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

  it('requires and records approval for service restart', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const requested = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '重启 nginx 服务' },
    });
    expect(requested.statusCode).toBe(202);
    const approvalId = (requested.json() as { approvalId: string }).approvalId;
    expect((requested.json() as { status: string }).status).toBe('awaiting_approval');

    const list = await app.inject({
      method: 'GET',
      url: '/api/agent-instruction-approvals',
      headers: { cookie },
    });
    expect((list.json() as Array<{ id: string }>).some((item) => item.id === approvalId)).toBe(true);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/agent-instruction-approvals/${approvalId}/decision`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(202);
    const commandId = (approved.json() as { instructionId: string }).instructionId;
    const command = await pool.query<{ type: string; instruction_intent: Record<string, unknown> }>(
      'SELECT type, instruction_intent FROM agent_commands WHERE id = $1',
      [commandId],
    );
    expect(command.rows[0]?.type).toBe('agent_instruction');
    expect(command.rows[0]?.instruction_intent).toMatchObject({ kind: 'service_restart', params: { service: 'nginx' } });

    const history = await app.inject({
      method: 'GET',
      url: '/api/agent-instruction-approvals?status=decided',
      headers: { cookie },
    });
    expect((history.json() as Array<{ id: string; status: string }>).some((item) => item.id === approvalId && item.status === 'approved')).toBe(true);

    const stopRequested = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '停止 nginx 服务' },
    });
    const stopApprovalId = (stopRequested.json() as { approvalId: string }).approvalId;
    const stopApproved = await app.inject({
      method: 'POST',
      url: `/api/agent-instruction-approvals/${stopApprovalId}/decision`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    const stopCommandId = (stopApproved.json() as { instructionId: string }).instructionId;
    const stopCommand = await pool.query<{ instruction_intent: Record<string, unknown> }>(
      'SELECT instruction_intent FROM agent_commands WHERE id = $1',
      [stopCommandId],
    );
    expect(stopCommand.rows[0]?.instruction_intent).toMatchObject({ kind: 'service_stop', params: { service: 'nginx' } });

    const expiredRequest = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '重启 redis 服务' },
    });
    const expiredApprovalId = (expiredRequest.json() as { approvalId: string }).approvalId;
    await pool.query(
      `UPDATE agent_instruction_approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expiredApprovalId],
    );
    const expiredDecision = await app.inject({
      method: 'POST',
      url: `/api/agent-instruction-approvals/${expiredApprovalId}/decision`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(expiredDecision.statusCode).toBe(409);
    expect((expiredDecision.json() as { error: string }).error).toBe('approval_expired');

    const pendingRequest = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '停止 redis 服务' },
    });
    const pendingApprovalId = (pendingRequest.json() as { approvalId: string }).approvalId;
    const preflight = await app.inject({
      method: 'POST',
      url: '/api/agent-instruction-approvals/batch-decision',
      headers: { cookie },
      payload: { approvalIds: [expiredApprovalId, pendingApprovalId], decision: 'approve' },
    });
    expect(preflight.statusCode).toBe(409);
    expect((preflight.json() as { error: string }).error).toBe('batch_preflight_failed');
    const stillPending = await app.inject({
      method: 'GET',
      url: '/api/agent-instruction-approvals',
      headers: { cookie },
    });
    expect((stillPending.json() as Array<{ id: string }>).some((item) => item.id === pendingApprovalId)).toBe(true);
    await app.inject({
      method: 'POST',
      url: `/api/agent-instruction-approvals/${pendingApprovalId}/decision`,
      headers: { cookie },
      payload: { decision: 'deny' },
    });

    const cancelRequest = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '重启 nginx 服务' },
    });
    const cancelApprovalId = (cancelRequest.json() as { approvalId: string }).approvalId;
    const canceled = await app.inject({
      method: 'POST',
      url: `/api/agent-instruction-approvals/${cancelApprovalId}/cancel`,
      headers: { cookie },
      payload: {},
    });
    expect(canceled.statusCode).toBe(200);
    expect((canceled.json() as { status: string }).status).toBe('canceled');
    await app.close();
  });

  it('can require separation of duties for approvals', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const requested = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '重启 redis 服务' },
    });
    const approvalId = (requested.json() as { approvalId: string }).approvalId;
    process.env.OPSAGENT_REQUIRE_SEPARATION_OF_DUTIES = 'true';
    try {
      const forbidden = await app.inject({
        method: 'POST',
        url: `/api/agent-instruction-approvals/${approvalId}/decision`,
        headers: { cookie },
        payload: { decision: 'approve' },
      });
      expect(forbidden.statusCode).toBe(403);
      expect((forbidden.json() as { error: string }).error).toBe('self_approval_forbidden');
    } finally {
      delete process.env.OPSAGENT_REQUIRE_SEPARATION_OF_DUTIES;
    }
    const denied = await app.inject({
      method: 'POST',
      url: `/api/agent-instruction-approvals/${approvalId}/decision`,
      headers: { cookie },
      payload: { decision: 'deny' },
    });
    expect(denied.statusCode).toBe(200);
    await app.close();
  });

  it('links approved write commands to incidents', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const incidentResponse = await app.inject({
      method: 'POST',
      url: '/api/incidents',
      headers: { cookie },
      payload: { title: '写操作关联测试', severity: 'P2' },
    });
    const incidentId = (incidentResponse.json() as { id: string }).id;
    const requested = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '重启 nginx 服务', incidentId },
    });
    const approvalId = (requested.json() as { approvalId: string }).approvalId;
    const requestedEvents = await pool.query<{ type: string }>(
      'SELECT type FROM incident_events WHERE incident_id = $1',
      [incidentId],
    );
    expect(requestedEvents.rows.some((row) => row.type === 'instruction_approval_requested')).toBe(true);
    const requestedNotice = await pool.query<{ title: string }>(
      `SELECT title FROM messages WHERE tenant_id = $1 AND title = 'Agent 写操作待审批' LIMIT 1`,
      [tenantId],
    );
    expect(requestedNotice.rows[0]?.title).toBe('Agent 写操作待审批');
    const approved = await app.inject({
      method: 'POST',
      url: `/api/agent-instruction-approvals/${approvalId}/decision`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(202);
    const instructionId = (approved.json() as { instructionId: string }).instructionId;
    const command = await pool.query<{ incident_id: string | null }>(
      'SELECT incident_id FROM agent_commands WHERE id = $1',
      [instructionId],
    );
    expect(command.rows[0]?.incident_id).toBe(incidentId);
    const linked = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incidentId}/instructions`,
      headers: { cookie },
    });
    expect((linked.json() as Array<{ instructionId: string }>).some((item) => item.instructionId === instructionId)).toBe(true);
    const approvedEvents = await pool.query<{ type: string }>(
      'SELECT type FROM incident_events WHERE incident_id = $1',
      [incidentId],
    );
    expect(approvedEvents.rows.some((row) => row.type === 'instruction_approval_approved')).toBe(true);
    await app.close();
  });

  it('allows only one concurrent approval decision', async () => {
    const app = buildServer({ pool, localAdmin: { enabled: true, username: 'tenant-admin' } });
    const cookie = await login(app);
    const requested = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/instructions`,
      headers: { cookie },
      payload: { instruction: '重启 nginx 服务' },
    });
    const approvalId = (requested.json() as { approvalId: string }).approvalId;
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/agent-instruction-approvals/${approvalId}/decision`,
        headers: { cookie },
        payload: { decision: 'approve' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/agent-instruction-approvals/${approvalId}/decision`,
        headers: { cookie },
        payload: { decision: 'approve' },
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    const commands = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_commands c
       JOIN agent_instruction_approvals a ON a.command_id = c.id WHERE a.id = $1`,
      [approvalId],
    );
    expect(commands.rows[0]?.count).toBe('1');
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
