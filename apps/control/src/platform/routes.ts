import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { PlatformTenantService } from './service.js';

async function platformAdmin(pool: Pool, request: FastifyRequest): Promise<string | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await readSession(pool, token);
  if (!session) return null;
  const result = await pool.query<{ is_platform_admin: boolean }>(
    'SELECT is_platform_admin FROM users WHERE id = $1',
    [session.user.id],
  );
  return result.rows[0]?.is_platform_admin ? session.user.id : null;
}

export function registerPlatformRoutes(app: FastifyInstance, pool: Pool): void {
  const tenants = new PlatformTenantService(pool);

  app.get('/api/platform/tenants', async (request, reply) => {
    if (!(await platformAdmin(pool, request))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send(await tenants.list());
  });

  app.post('/api/platform/tenants', async (request, reply) => {
    if (!(await platformAdmin(pool, request))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = request.body as { name?: unknown; slug?: unknown } | undefined;
    if (typeof body?.name !== 'string' || typeof body.slug !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      return reply.code(201).send(await tenants.create({ name: body.name, slug: body.slug }));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        return reply.code(409).send({ error: 'tenant_slug_exists' });
      }
      throw error;
    }
  });
}
