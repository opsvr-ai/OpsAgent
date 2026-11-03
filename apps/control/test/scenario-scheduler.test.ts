import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ScenarioService, type ToolResolver } from '../src/scenarios/service.js';
import { ScenarioScheduler } from '../src/scenarios/scheduler.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const tools: ToolResolver = {
  resolve(name) {
    if (name !== 'mock.echo') return undefined;
    return { name, risk: 'R0', execute: async () => ({ ok: true }) };
  },
};

describe('scenario scheduler', () => {
  it('runs a due scenario once per interval', async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
    await seed(pool);

    const service = new ScenarioService(pool, tools);
    const scenario = await service.create({
      tenantId: '00000000-0000-4000-8000-000000000001',
      name: 'scheduled-check',
      definition: { steps: [{ name: 'echo', tool: 'mock.echo', input: {} }] },
    });
    await service.setSchedule('00000000-0000-4000-8000-000000000001', scenario.id, 60);

    const scheduler = new ScenarioScheduler(service);
    const first = await scheduler.tick(new Date('2026-11-03T12:00:00Z'));
    expect(first).toBe(1);
    const second = await scheduler.tick(new Date('2026-11-03T12:00:30Z'));
    expect(second).toBe(0);
    const runs = await service.listRuns('00000000-0000-4000-8000-000000000001', scenario.id);
    expect(runs).toHaveLength(1);

    await pool.end();
  });
});
