import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { PgAuditWriter } from '../src/audit/writer.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const demo = '00000000-0000-4000-8000-000000000001';
const admin = '00000000-0000-4000-8000-0000000000a2';
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('audit writer', () => {
  it('persists metadata with secrets redacted', async () => {
    const writer = new PgAuditWriter(pool);
    await writer.write({
      tenantId: demo,
      actorId: admin,
      action: 'auth.login',
      resource: 'local-admin',
      result: 'success',
      metadata: {
        method: 'local_admin',
        password: 'do-not-store',
        nested: { token: 'also-secret', safe: 'ok' },
      },
    });

    const result = await pool.query<{ metadata: Record<string, unknown>; action: string }>(
      'SELECT action, metadata FROM audit_events WHERE action = $1 ORDER BY created_at DESC LIMIT 1',
      ['auth.login'],
    );

    expect(result.rows[0]?.action).toBe('auth.login');
    expect(result.rows[0]?.metadata).toMatchObject({
      method: 'local_admin',
      password: '[REDACTED]',
      nested: { token: '[REDACTED]', safe: 'ok' },
    });
  });
});
