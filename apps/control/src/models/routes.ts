import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { ModelProviderService } from './service.js';

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

export function registerModelRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
  secret: string,
): void {
  const models = new ModelProviderService(pool, secret);

  app.get('/api/models', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'model.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await models.list(ctx.tenantId));
  });

  app.post('/api/models', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'model.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as {
      name?: unknown;
      provider?: unknown;
      baseUrl?: unknown;
      model?: unknown;
      apiKey?: unknown;
    } | undefined;
    if (
      typeof body?.name !== 'string' ||
      typeof body.provider !== 'string' ||
      typeof body.baseUrl !== 'string' ||
      typeof body.model !== 'string' ||
      typeof body.apiKey !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const provider = await models.create({
      tenantId: ctx.tenantId,
      name: body.name,
      provider: body.provider,
      baseUrl: body.baseUrl,
      model: body.model,
      apiKey: body.apiKey,
    });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'model.create',
      resource: provider.id,
      result: 'success',
      metadata: { provider: provider.provider, model: provider.model, name: provider.name },
    });
    return reply.code(201).send(provider);
  });

  app.delete<{ Params: { id: string } }>('/api/models/:id', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'model.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const removed = await models.delete(ctx.tenantId, request.params.id);
    if (!removed) return reply.code(404).send({ error: 'model_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'model.delete',
      resource: request.params.id,
      result: 'success',
    });
    return reply.send({ ok: true });
  });
}
