import { permissionsFor, isRoleId, type RoleId } from '@opsagent/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  LocalAdminDisabledError,
  authenticateLocalAdmin,
  type LocalAdminConfig,
} from './local-admin.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  issueSession,
  readSession,
  revokeSession,
} from './session.js';

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE];
}

async function buildMe(pool: Pool, userId: string) {
  const userResult = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    is_platform_admin: boolean;
  }>('SELECT id, username, display_name, is_platform_admin FROM users WHERE id = $1', [userId]);
  const user = userResult.rows[0];
  if (!user) return null;

  const tenantsResult = await pool.query<{
    id: string;
    slug: string;
    name: string;
    roles: string[];
  }>(
    `SELECT t.id, t.slug, t.name,
            COALESCE(array_agg(DISTINCT ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS roles
     FROM memberships m
     JOIN tenants t ON t.id = m.tenant_id
     LEFT JOIN user_roles ur ON ur.tenant_id = m.tenant_id AND ur.user_id = m.user_id
     WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'
     GROUP BY t.id, t.slug, t.name
     ORDER BY t.slug`,
    [userId],
  );

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      isPlatformAdmin: user.is_platform_admin,
    },
    tenants: tenantsResult.rows.map((tenant) => {
      const roles = tenant.roles.filter(isRoleId) as RoleId[];
      return {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        roles,
        permissions: permissionsFor(roles),
      };
    }),
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  localAdmin: LocalAdminConfig,
): void {
  app.post('/api/auth/local-admin', async (request, reply) => {
    const body = request.body as LoginBody | undefined;
    if (typeof body?.username !== 'string' || typeof body.password !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    try {
      const user = await authenticateLocalAdmin(pool, localAdmin, body.username, body.password);
      if (!user) return reply.code(401).send({ error: 'invalid_credentials' });

      const membership = await pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1',
        [user.id],
      );
      const session = await issueSession(pool, user.id, membership.rows[0]?.tenant_id ?? null);
      reply.setCookie(SESSION_COOKIE, session.token, cookieOptions());
      return reply.send({ ok: true });
    } catch (error) {
      if (error instanceof LocalAdminDisabledError) {
        return reply.code(403).send({ error: 'local_admin_disabled' });
      }
      throw error;
    }
  });

  app.get('/api/me', async (request, reply) => {
    const token = sessionToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });

    const session = await readSession(pool, token);
    if (!session) return reply.code(401).send({ error: 'unauthorized' });

    const me = await buildMe(pool, session.user.id);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(me);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = sessionToken(request);
    if (token) await revokeSession(pool, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
}

export type { AuthUser } from './session.js';
export type { LocalAdminConfig } from './local-admin.js';
