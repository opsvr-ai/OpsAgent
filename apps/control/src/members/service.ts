import type { Pool } from 'pg';

export interface MemberRecord {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly roles: readonly string[];
}

export class MemberService {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<MemberRecord[]> {
    const result = await this.pool.query<{
      user_id: string;
      username: string;
      display_name: string;
      status: string;
      roles: string[];
    }>(
      `SELECT u.id AS user_id, u.username, u.display_name, m.status,
              COALESCE(array_agg(ur.role_id ORDER BY ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS roles
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN user_roles ur ON ur.tenant_id = m.tenant_id AND ur.user_id = m.user_id
       WHERE m.tenant_id = $1
       GROUP BY u.id, u.username, u.display_name, m.status
       ORDER BY u.username`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      status: row.status,
      roles: row.roles,
    }));
  }

  async setRoles(input: {
    tenantId: string;
    userId: string;
    roleIds: readonly string[];
  }): Promise<MemberRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const roles = await client.query<{ id: string }>(
        `SELECT id FROM roles WHERE id = ANY($1::text[])`,
        [input.roleIds],
      );
      if (roles.rowCount !== input.roleIds.length) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        'DELETE FROM user_roles WHERE tenant_id = $1 AND user_id = $2',
        [input.tenantId, input.userId],
      );
      for (const roleId of input.roleIds) {
        await client.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
          [input.tenantId, input.userId, roleId],
        );
      }
      const remainingAdmin = await client.query<{ count: string }>(
        `SELECT count(*) FROM user_roles WHERE tenant_id = $1 AND role_id = 'tenant_admin'`,
        [input.tenantId],
      );
      if (Number(remainingAdmin.rows[0]?.count ?? 0) === 0) {
        await client.query('ROLLBACK');
        throw new Error('last_tenant_admin');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.get(input.tenantId, input.userId);
  }

  private async get(tenantId: string, userId: string): Promise<MemberRecord | null> {
    const members = await this.list(tenantId);
    return members.find((member) => member.userId === userId) ?? null;
  }
}
