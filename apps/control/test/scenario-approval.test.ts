import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { ScenarioService, type ToolResolver } from '../src/scenarios/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const tenant = '00000000-0000-4000-8000-000000000001';
let pool: Pool;
let adminId = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
  const admin = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username = 'tenant-admin'",
  );
  adminId = admin.rows[0]?.id ?? '';
});

afterAll(async () => {
  await pool.end();
});

describe('scenario approval gate', () => {
  it('pauses before an R2 tool and resumes after approval', async () => {
    const execute = vi.fn().mockResolvedValue({ restarted: true });
    const tools: ToolResolver = {
      async resolve(_tenantId, name) {
        return name === 'restart'
          ? { name, risk: 'R2', execute }
          : { name, risk: 'R0', execute: async () => ({ ok: true }) };
      },
    };
    const service = new ScenarioService(pool, tools);
    const scenario = await service.create({
      tenantId: tenant,
      name: 'approval-gate',
      definition: {
        steps: [
          { name: 'restart', tool: 'restart', input: {} },
          { name: 'check', tool: 'check', input: {} },
        ],
      },
    });

    const paused = await service.run(tenant, scenario.id);
    expect(paused).toMatchObject({ status: 'awaiting_approval' });
    expect(execute).not.toHaveBeenCalled();

    const approved = await service.approve({
      tenantId: tenant,
      runId: paused?.runId ?? '',
      userId: adminId,
      decision: 'approve',
    });
    expect(approved).toMatchObject({ status: 'success' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects an R2 tool without executing it', async () => {
    const execute = vi.fn();
    const service = new ScenarioService(pool, {
      async resolve() {
        return { name: 'restart', risk: 'R2', execute };
      },
    });
    const scenario = await service.create({
      tenantId: tenant,
      name: 'approval-reject',
      definition: { steps: [{ name: 'restart', tool: 'restart', input: {} }] },
    });
    const paused = await service.run(tenant, scenario.id);
    const rejected = await service.approve({
      tenantId: tenant,
      runId: paused?.runId ?? '',
      userId: adminId,
      decision: 'reject',
      reason: 'no',
    });
    expect(rejected).toMatchObject({ status: 'failed', error: 'approval_rejected' });
    expect(execute).not.toHaveBeenCalled();
  });
});
