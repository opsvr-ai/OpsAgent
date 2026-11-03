import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

export const SESSION_COOKIE = 'opsagent_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface AuthUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly isPlatformAdmin: boolean;
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueSession(
  pool: Pool,
  userId: string,
  selectedTenantId: string | null,
): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await pool.query(
    `INSERT INTO auth_sessions (user_id, selected_tenant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, selectedTenantId, tokenHash, expiresAt],
  );

  return { token, expiresAt };
}

export async function readSession(
  pool: Pool,
  token: string,
): Promise<{ user: AuthUser; selectedTenantId: string | null } | null> {
  const result = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    email: string | null;
    is_platform_admin: boolean;
    selected_tenant_id: string | null;
  }>(
    `SELECT u.id, u.username, u.display_name, u.email, u.is_platform_admin, s.selected_tenant_id
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [hashSessionToken(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      isPlatformAdmin: row.is_platform_admin,
    },
    selectedTenantId: row.selected_tenant_id,
  };
}

export async function revokeSession(pool: Pool, token: string): Promise<void> {
  await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
}
