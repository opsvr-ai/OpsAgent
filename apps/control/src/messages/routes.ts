import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { MessageService } from './service.js';

async function context(pool: Pool, request: FastifyRequest): Promise<TenantContext | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await readSession(pool, token);
  if (!session?.selectedTenantId) return null;
  return resolveTenantContext(
    { userId: session.user.id, tenantId: session.selectedTenantId },
    createMembershipRepository(pool),
  );
}

export function registerMessageRoutes(app: FastifyInstance, pool: Pool): void {
  const messages = new MessageService(pool);

  app.get('/api/messages', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(await messages.list(ctx.tenantId, ctx.userId));
  });

  app.post<{ Params: { id: string } }>('/api/messages/:id/read', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    const ok = await messages.markRead(ctx.tenantId, ctx.userId, request.params.id);
    if (!ok) return reply.code(404).send({ error: 'message_not_found' });
    return reply.send({ ok: true });
  });
}
