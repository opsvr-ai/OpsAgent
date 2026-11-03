import { ROLE_IDS, ROLE_TEMPLATES } from '@opsagent/contracts';
import type { Pool } from 'pg';

const tenantDemo = '00000000-0000-4000-8000-000000000001';
const tenantOther = '00000000-0000-4000-8000-000000000002';
const platformAdmin = '00000000-0000-4000-8000-0000000000a1';
const tenantAdmin = '00000000-0000-4000-8000-0000000000a2';
const sreDba = '00000000-0000-4000-8000-0000000000a3';

export async function seed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const roleId of ROLE_IDS) {
      const role = ROLE_TEMPLATES[roleId];
      await client.query(
        `INSERT INTO roles (id, name, builtin) VALUES ($1, $2, true)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [role.id, role.name],
      );
      for (const permission of role.permissions) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [role.id, permission],
        );
      }
    }

    await client.query(
      `INSERT INTO tenants (id, slug, name, status, isolation_mode)
       VALUES ($1, 'tenant-demo', 'Demo Tenant', 'active', 'dedicated'),
              ($2, 'tenant-other', 'Other Tenant', 'active', 'dedicated')
       ON CONFLICT (id) DO NOTHING`,
      [tenantDemo, tenantOther],
    );

    await client.query(
      `INSERT INTO users (id, username, display_name, email, is_platform_admin)
       VALUES ($1, 'platform-admin', 'Platform Admin', 'platform@example.test', true),
              ($2, 'tenant-admin', 'Tenant Admin', 'tenant-admin@example.test', false),
              ($3, 'sre-dba', 'SRE / DBA', 'sre-dba@example.test', false)
       ON CONFLICT (id) DO NOTHING`,
      [platformAdmin, tenantAdmin, sreDba],
    );

    await client.query(
      `INSERT INTO memberships (tenant_id, user_id, status)
       VALUES ($1, $2, 'active'), ($1, $3, 'active')
       ON CONFLICT DO NOTHING`,
      [tenantDemo, tenantAdmin, sreDba],
    );

    await client.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id)
       VALUES ($1, $2, 'tenant_admin'), ($1, $3, 'sre_duty'), ($1, $3, 'dba')
       ON CONFLICT DO NOTHING`,
      [tenantDemo, tenantAdmin, sreDba],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
