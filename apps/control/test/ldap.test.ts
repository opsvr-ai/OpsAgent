import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import type { LdapAuthenticator } from '../src/auth/ldap.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
let pool: Pool;

const fakeLdap: LdapAuthenticator = {
  async authenticate(username, password) {
    if (username !== 'tenant-admin' || password !== 'ldap-password') return null;
    return {
      username: 'tenant-admin',
      displayName: 'Tenant Admin',
      email: 'tenant-admin@example.test',
      dn: 'uid=tenant-admin,ou=people,dc=example,dc=com',
    };
  },
};

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

describe('LDAP login', () => {
  it('creates a session for a valid LDAP user', async () => {
    const app = buildServer({ pool, ldap: fakeLdap });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'tenant-admin', password: 'ldap-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('opsagent_session=');

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'auth.login' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ method: 'ldap' });
    await app.close();
  });

  it('rejects invalid LDAP credentials without a session', async () => {
    const app = buildServer({ pool, ldap: fakeLdap });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'tenant-admin', password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    await app.close();
  });
});
