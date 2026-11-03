import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { INCIDENT_STATUSES, IncidentService, type IncidentStatus } from './service.js';

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

export function registerIncidentRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const incidents = new IncidentService(pool);

  app.get('/api/incidents', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'incident.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await incidents.list(ctx.tenantId));
  });

  app.post('/api/incidents', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'incident.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { title?: unknown; severity?: unknown } | undefined;
    if (typeof body?.title !== 'string' || typeof body.severity !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const incident = await incidents.create({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      title: body.title,
      severity: body.severity,
    });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'incident.create',
      resource: incident.id,
      result: 'success',
      metadata: { severity: incident.severity },
    });
    return reply.code(201).send(incident);
  });

  app.get<{ Params: { id: string } }>('/api/incidents/:id', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'incident.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const detail = await incidents.getWithEvents(ctx.tenantId, request.params.id);
    if (!detail) return reply.code(404).send({ error: 'incident_not_found' });
    return reply.send(detail);
  });

  app.patch<{ Params: { id: string } }>('/api/incidents/:id', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'incident.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { status?: unknown; commanderId?: unknown } | undefined;
    if (body?.status !== undefined && !INCIDENT_STATUSES.includes(body.status as IncidentStatus)) {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    const incident = await incidents.update({
      tenantId: ctx.tenantId,
      id: request.params.id,
      actorId: ctx.userId,
      ...(body?.status !== undefined ? { status: body.status as IncidentStatus } : {}),
      ...(body?.commanderId === null || typeof body?.commanderId === 'string'
        ? { commanderId: body.commanderId as string | null }
        : {}),
    });
    if (!incident) return reply.code(404).send({ error: 'incident_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'incident.update',
      resource: incident.id,
      result: 'success',
      metadata: { status: incident.status },
    });
    return reply.send(incident);
  });
}
