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
  internalToken?: string,
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

  app.get<{ Params: { id: string } }>('/api/incidents/:id/report', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'incident.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const report = await incidents.report(ctx.tenantId, request.params.id);
    if (!report) return reply.code(404).send({ error: 'incident_not_found' });
    return reply.type('text/markdown; charset=utf-8').send(report);
  });

  app.post('/internal/incident-sources', async (request, reply) => {
    if (internalToken && request.headers['x-opsagent-token'] !== internalToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as {
      tenantId?: unknown;
      source?: unknown;
      sourceRef?: unknown;
      title?: unknown;
      severity?: unknown;
      appSystemId?: unknown;
      rootCause?: unknown;
      evidence?: unknown;
    } | undefined;
    const sources = ['alertmanager', 'zabbix', 'webhook'];
    if (
      typeof body?.tenantId !== 'string' ||
      typeof body.source !== 'string' || !sources.includes(body.source) ||
      typeof body.sourceRef !== 'string' ||
      typeof body.title !== 'string' ||
      typeof body.severity !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const evidence = Array.isArray(body.evidence)
      ? body.evidence
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          kind: typeof item.kind === 'string' ? item.kind : 'source',
          source: typeof item.source === 'string' ? item.source : String(body.source),
          summary: typeof item.summary === 'string' ? item.summary : '',
          payload: typeof item.payload === 'object' && item.payload !== null && !Array.isArray(item.payload)
            ? item.payload as Record<string, unknown>
            : {},
        }))
      : [];
    try {
      const result = await incidents.createFromSource({
        tenantId: body.tenantId,
        source: body.source as 'alertmanager' | 'zabbix' | 'webhook',
        sourceRef: body.sourceRef,
        title: body.title,
        severity: body.severity,
        ...(typeof body.appSystemId === 'string' ? { appSystemId: body.appSystemId } : {}),
        ...(typeof body.rootCause === 'string' ? { rootCause: body.rootCause } : {}),
        evidence,
      });
      if (!result) return reply.code(404).send({ error: 'tenant_or_app_system_not_found' });
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      request.log.warn({ err: error }, 'incident source ingestion failed');
      return reply.code(409).send({ error: 'source_conflict' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/incidents/:id/approvals', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'incident.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { action?: unknown; risk?: unknown; details?: unknown } | undefined;
    if (typeof body?.action !== 'string' || (body.risk !== 'R2' && body.risk !== 'R3')) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const detail = await incidents.requestApproval({
      tenantId: ctx.tenantId,
      incidentId: request.params.id,
      actorId: ctx.userId,
      action: body.action,
      risk: body.risk,
      ...(typeof body.details === 'object' && body.details !== null && !Array.isArray(body.details)
        ? { details: body.details as Record<string, unknown> }
        : {}),
    });
    if (!detail) return reply.code(404).send({ error: 'incident_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'incident.approval.request',
      resource: request.params.id,
      result: 'success',
      metadata: { action: body.action, risk: body.risk },
    });
    return reply.code(201).send(detail);
  });

  app.post<{ Params: { id: string; approvalId: string } }>(
    '/api/incidents/:id/approvals/:approvalId/decision',
    async (request, reply) => {
      const ctx = await context(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'incident.manage');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }
      const body = request.body as { decision?: unknown; reason?: unknown } | undefined;
      if (body?.decision !== 'approve' && body?.decision !== 'deny') {
        return reply.code(400).send({ error: 'invalid_decision' });
      }
      const detail = await incidents.decideApproval({
        tenantId: ctx.tenantId,
        incidentId: request.params.id,
        approvalId: request.params.approvalId,
        actorId: ctx.userId,
        decision: body.decision,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      if (!detail) return reply.code(404).send({ error: 'approval_not_found' });
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'incident.approval.decide',
        resource: request.params.id,
        result: 'success',
        metadata: { decision: body.decision, approvalId: request.params.approvalId },
      });
      return reply.send(detail);
    },
  );

  app.post<{ Params: { id: string } }>('/api/incidents/:id/investigate', async (request, reply) => {    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'incident.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const detail = await incidents.investigate({
      tenantId: ctx.tenantId,
      id: request.params.id,
      actorId: ctx.userId,
    });
    if (!detail) return reply.code(404).send({ error: 'incident_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'incident.investigate',
      resource: request.params.id,
      result: 'success',
      metadata: { evidence: detail.evidence.length },
    });
    return reply.send(detail);
  });
}
