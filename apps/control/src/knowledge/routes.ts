import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { KnowledgeService } from './service.js';

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

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const knowledge = new KnowledgeService(pool);

  app.get<{ Querystring: { q?: string } }>('/api/knowledge', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(await knowledge.list(ctx.tenantId, request.query.q));
  });

  app.post('/api/knowledge', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'knowledge.publish');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { title?: unknown; body?: unknown } | undefined;
    if (typeof body?.title !== 'string' || typeof body.body !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const document = await knowledge.create({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      title: body.title,
      body: body.body,
    });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'knowledge.create',
      resource: document.id,
      result: 'success',
    });
    return reply.code(201).send(document);
  });

  app.post<{ Params: { id: string } }>('/api/knowledge/:id/publish', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'knowledge.publish');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const document = await knowledge.publish(ctx.tenantId, request.params.id);
    if (!document) return reply.code(404).send({ error: 'knowledge_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'knowledge.publish',
      resource: document.id,
      result: 'success',
    });
    return reply.send(document);
  });
}
