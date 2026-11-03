import { isRoleId, type RoleId } from '@opsagent/contracts';
import type { Pool } from 'pg';
import type { MembershipRepository } from './context.js';

export function createMembershipRepository(pool: Pool): MembershipRepository {
  return {
    async findMembership(userId, tenantId) {
      const result = await pool.query<{ is_platform_admin: boolean; roles: string[] }>(
        `SELECT u.is_platform_admin,
                COALESCE(array_agg(DISTINCT ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS roles
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 AND m.status = 'active'
         JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
         LEFT JOIN user_roles ur ON ur.tenant_id = m.tenant_id AND ur.user_id = m.user_id
         WHERE u.id = $1 AND u.status = 'active'
         GROUP BY u.is_platform_admin`,
        [userId, tenantId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        roles: row.roles.filter(isRoleId) as RoleId[],
        isPlatformAdmin: row.is_platform_admin,
      };
    },
  };
}
