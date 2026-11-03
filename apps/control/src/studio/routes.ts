import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import {
  StudioConflictError,
  StudioNotFoundError,
  StudioService,
  type StudioGenerator,
} from './service.js';

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

export function registerStudioRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
  generator?: StudioGenerator,
): void {
  const studio = new StudioService(pool, generator);

  app.get('/api/studio/sessions', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await studio.list(ctx.tenantId));
  });

  app.post('/api/studio/sessions', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { goal?: unknown; platform?: unknown } | undefined;
    if (typeof body?.goal !== 'string' || typeof body.platform !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const session = await studio.create({
      tenantId: ctx.tenantId,
      requestedBy: ctx.userId,
      goal: body.goal,
      platform: body.platform,
    });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'studio.create',
      resource: session.id,
      result: 'success',
      metadata: { platform: session.platform, status: session.status },
    });
    return reply.code(201).send(session);
  });

  app.post<{ Params: { id: string } }>('/api/studio/sessions/:id/submit', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    try {
      const session = await studio.submit(ctx.tenantId, request.params.id);
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'studio.submit',
        resource: session.id,
        result: 'success',
      });
      return reply.send(session);
    } catch (error) {
      if (error instanceof StudioConflictError) {
        return reply.code(409).send({ error: 'studio_not_generated' });
      }
      if (error instanceof StudioNotFoundError) {
        return reply.code(404).send({ error: 'studio_not_found' });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/studio/sessions/:id/review', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { decision?: unknown; reason?: unknown } | undefined;
    if (body?.decision !== 'approve' && body?.decision !== 'reject') {
      return reply.code(400).send({ error: 'invalid_decision' });
    }
    try {
      const session = await studio.review({
        tenantId: ctx.tenantId,
        id: request.params.id,
        reviewerId: ctx.userId,
        decision: body.decision,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'studio.review',
        resource: session.id,
        result: 'success',
        metadata: { decision: body.decision },
      });
      return reply.send(session);
    } catch (error) {
      if (error instanceof StudioNotFoundError) {
        return reply.code(404).send({ error: 'studio_not_found' });
      }
      throw error;
    }
  });
}
