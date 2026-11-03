import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { ConnectorService } from './service.js';

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
): void {
  const connectors = new ConnectorService(pool);

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
}
