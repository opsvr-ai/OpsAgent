import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const tenant = '00000000-0000-4000-8000-000000000001';
const runtimeSession = 'dsh-internal-1';
let pool: Pool;
let userId = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
  const admin = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username = 'tenant-admin'",
  );
  userId = admin.rows[0]?.id ?? '';
  await pool.query(
    `INSERT INTO runtime_sessions (tenant_id, user_id, runtime_session_id, role_view, status)
     VALUES ($1, $2, $3, 'tenant_admin', 'active')`,
    [tenant, userId, runtimeSession],
  );
});

afterAll(async () => {
  await pool.end();
});

describe('internal approval bridge API', () => {
  it('creates, polls and decides an approval', async () => {
    const app = buildServer({ pool, internalToken: 'secret' });
    const created = await app.inject({
      method: 'POST',
      url: '/internal/approvals',
      headers: { 'x-opsagent-token': 'secret' },
      payload: { tenantId: tenant, runtimeSessionId: runtimeSession, tool: 'write', callId: 'c1' },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const pending = await app.inject({
      method: 'GET',
      url: `/internal/approvals/${id}`,
      headers: { 'x-opsagent-token': 'secret' },
    });
    expect(pending.json()).toEqual({ status: 'pending' });

    const decided = await app.inject({
      method: 'POST',
      url: `/internal/approvals/${id}/decision`,
      headers: { 'x-opsagent-token': 'secret' },
      payload: { decision: 'approve' },
    });
    expect(decided.statusCode).toBe(200);

    const approved = await app.inject({
      method: 'GET',
      url: `/internal/approvals/${id}`,
      headers: { 'x-opsagent-token': 'secret' },
    });
    expect(approved.json()).toEqual({ status: 'approved' });
    await app.close();
  });

  it('rejects a bad internal token', async () => {
    const app = buildServer({ pool, internalToken: 'secret' });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/approvals',
      headers: { 'x-opsagent-token': 'wrong' },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
