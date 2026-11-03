import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { ConnectorService } from './service.js';
import type { ProbeRegistry } from './probe.js';
import { ConnectorCredentialService } from './credentials.js';

interface CreateConnectorBody {
  connectorType?: unknown;
  name?: unknown;
  config?: unknown;
  credentialRef?: unknown;
}

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

export function registerConnectorRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
  probes: ProbeRegistry,
  secret: string,
): void {
  const connectors = new ConnectorService(pool);
  const credentials = new ConnectorCredentialService(pool, secret);

  app.get('/api/connectors', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await connectors.list(ctx.tenantId));
  });

  app.get<{ Params: { id: string } }>('/api/connectors/:id', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const connector = await connectors.get(ctx.tenantId, request.params.id);
    if (!connector) return reply.code(404).send({ error: 'connector_not_found' });
    return reply.send({
      ...connector,
      hasCredentials: await credentials.has(ctx.tenantId, connector.id),
    });
  });

  app.post('/api/connectors', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }

    const body = request.body as CreateConnectorBody | undefined;
    if (
      typeof body?.connectorType !== 'string' ||
      typeof body.name !== 'string' ||
      typeof body.config !== 'object' ||
      body.config === null ||
      Array.isArray(body.config)
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    try {
      const created = await connectors.create({
        tenantId: ctx.tenantId,
        connectorType: body.connectorType,
        name: body.name,
        config: body.config as Readonly<Record<string, unknown>>,
        ...(typeof body.credentialRef === 'string' ? { credentialRef: body.credentialRef } : {}),
      });
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'connector.create',
        resource: created.id,
        result: 'success',
        metadata: { connectorType: created.connectorType, name: created.name },
      });
      return reply.code(201).send(created);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        return reply.code(409).send({ error: 'connector_name_exists' });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/connectors/:id/test', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }

    const connector = await connectors.get(ctx.tenantId, request.params.id);
    if (!connector) return reply.code(404).send({ error: 'connector_not_found' });
    const probe = probes.get(connector.connectorType);
    if (!probe) return reply.code(501).send({ error: 'probe_not_implemented' });

    const result = await probe.probe(connector);
    const status = result.ok ? 'healthy' : 'unhealthy';
    await connectors.updateStatus(ctx.tenantId, connector.id, status);
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'connector.test',
      resource: connector.id,
      result: result.ok ? 'success' : 'failure',
      metadata: { connectorType: connector.connectorType, latencyMs: result.latencyMs },
    });
    return reply.send({ status, latencyMs: result.latencyMs });
  });

  app.put<{ Params: { id: string } }>('/api/connectors/:id/credentials', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'connector.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { credentials?: unknown } | undefined;
    if (
      typeof body?.credentials !== 'object' ||
      body.credentials === null ||
      Array.isArray(body.credentials)
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const saved = await credentials.set(
      ctx.tenantId,
      request.params.id,
      body.credentials as Record<string, unknown>,
    );
    if (!saved) return reply.code(404).send({ error: 'connector_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'connector.credentials',
      resource: request.params.id,
      result: 'success',
    });
    return reply.send({ ok: true });
  });
}
