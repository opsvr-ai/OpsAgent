import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const ids = {
  demo: '00000000-0000-4000-8000-000000000001',
  other: '00000000-0000-4000-8000-000000000002',
  tenantAdmin: '00000000-0000-4000-8000-0000000000a2',
  sreDba: '00000000-0000-4000-8000-0000000000a3',
};

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opsagent_app') THEN
        CREATE ROLE opsagent_app NOLOGIN;
      END IF;
    END $$;
  `);
  await pool.query('GRANT USAGE ON SCHEMA public TO opsagent_app');
  await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opsagent_app');
});

afterAll(async () => {
  await pool.end();
});

describe('database schema and seed', () => {
  it('seeds nine roles, the demo tenant and the other tenant', async () => {
    const roles = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM roles');
    expect(roles.rows[0]?.count).toBe('9');

    const tenants = await pool.query<{ slug: string }>('SELECT slug FROM tenants ORDER BY slug');
    expect(tenants.rows.map((row) => row.slug)).toEqual(['tenant-demo', 'tenant-other']);
  });

  it('gives tenant admin the member management permission', async () => {
    const result = await pool.query(
      `SELECT 1 FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1 AND ur.tenant_id = $2 AND rp.permission = 'tenant.member.manage'`,
      [ids.tenantAdmin, ids.demo],
    );
    expect(result.rowCount).toBe(1);
  });

  it('stores both SRE and DBA roles for the multi-role user', async () => {
    const result = await pool.query<{ role_id: string }>(
      'SELECT role_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 ORDER BY role_id',
      [ids.sreDba, ids.demo],
    );
    expect(result.rows.map((row) => row.role_id)).toEqual(['dba', 'sre_duty']);
  });

  it('enforces tenant RLS for a non-owner application role', async () => {
    await pool.query('SET ROLE opsagent_app');
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [ids.demo]);

    const demoRows = await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM memberships');
    expect(demoRows.rows.length).toBeGreaterThan(0);
    expect(demoRows.rows.every((row) => row.tenant_id === ids.demo)).toBe(true);

    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [ids.other]);
    const otherRows = await pool.query('SELECT tenant_id FROM memberships');
    expect(otherRows.rows).toEqual([]);

    await pool.query('RESET ROLE');
  });
});
