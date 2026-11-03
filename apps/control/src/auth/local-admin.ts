import { verify } from '@node-rs/argon2';
import type { Pool } from 'pg';
import type { AuthUser } from './session.js';

export interface LocalAdminConfig {
  readonly enabled: boolean;
  readonly username: string;
}

export class LocalAdminDisabledError extends Error {
  readonly code = 'auth.local_admin.disabled';

  constructor() {
    super('local admin is disabled');
    this.name = 'LocalAdminDisabledError';
  }
}

export async function authenticateLocalAdmin(
  pool: Pool,
  config: LocalAdminConfig,
  username: string,
  password: string,
): Promise<AuthUser | null> {
  if (!config.enabled || username !== config.username) {
    if (!config.enabled) throw new LocalAdminDisabledError();
    return null;
  }

  const result = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    email: string | null;
    is_platform_admin: boolean;
    password_hash: string | null;
  }>(
    `SELECT id, username, display_name, email, is_platform_admin, password_hash
     FROM users WHERE username = $1 AND status = 'active'`,
    [username],
  );

  const user = result.rows[0];
  if (!user?.password_hash) return null;
  if (!(await verify(user.password_hash, password))) return null;

  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    email: user.email,
    isPlatformAdmin: user.is_platform_admin,
  };
}
