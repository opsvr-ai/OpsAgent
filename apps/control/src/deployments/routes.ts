import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import type { AuditWriter } from '../audit/writer.js';
import { DeploymentService } from './service.js';

async function context(pool: Pool, request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await readSession(pool, token);
  if (!session?.selectedTenantId) return null;
  return resolveTenantContext(
    { userId: session.user.id, tenantId: session.selectedTenantId },
    createMembershipRepository(pool),
  );
}

export function registerDeploymentRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const deployments = new DeploymentService(pool);

  app.post('/api/releases', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'deployment.approve');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as {
      appSystemId?: unknown;
      version?: unknown;
      artifactUrl?: unknown;
      sha256?: unknown;
      signature?: unknown;
    } | undefined;
    if (
      typeof body?.version !== 'string' ||
      typeof body.artifactUrl !== 'string' ||
      typeof body.sha256 !== 'string' ||
      typeof body.signature !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const release = await deployments.createRelease({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      version: body.version,
      artifactUrl: body.artifactUrl,
      sha256: body.sha256,
      signature: body.signature,
      ...(typeof body.appSystemId === 'string' ? { appSystemId: body.appSystemId } : {}),
    });
    if (!release) return reply.code(400).send({ error: 'invalid_release_signature' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'release.create',
      resource: release.id,
      result: 'success',
      metadata: { version: release.version },
    });
    return reply.code(201).send(release);
  });

  app.get('/api/releases', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'deployment.approve');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await deployments.listReleases(ctx.tenantId));
  });

  app.post('/api/deployments', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'deployment.approve');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as {
      releaseId?: unknown;
      environment?: unknown;
      strategy?: unknown;
      canaryPercent?: unknown;
    } | undefined;
    if (typeof body?.releaseId !== 'string') return reply.code(400).send({ error: 'invalid_request' });
    const strategy = body.strategy === 'canary' ? 'canary' : 'rolling';
    const canaryPercent = typeof body.canaryPercent === 'number' ? body.canaryPercent : undefined;
    const deployment = await deployments.createDeployment({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      releaseId: body.releaseId,
      environment: typeof body.environment === 'string' ? body.environment : 'production',
      strategy,
      ...(canaryPercent !== undefined ? { canaryPercent } : {}),
    });
    if (!deployment) return reply.code(404).send({ error: 'release_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'deployment.create',
      resource: deployment.id,
      result: 'success',
      metadata: { strategy, environment: deployment.environment },
    });
    return reply.code(201).send(deployment);
  });

  app.get('/api/deployments', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'deployment.approve');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await deployments.listDeployments(ctx.tenantId));
  });

  app.post<{ Params: { id: string } }>('/api/deployments/:id/decision', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'deployment.approve');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { decision?: unknown; reason?: unknown } | undefined;
    if (body?.decision !== 'approve' && body?.decision !== 'reject') {
      return reply.code(400).send({ error: 'invalid_decision' });
    }
    const deployment = await deployments.decideDeployment({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      deploymentId: request.params.id,
      decision: body.decision,
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    });
    if (!deployment) return reply.code(404).send({ error: 'deployment_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: body.decision === 'approve' ? 'deployment.approve' : 'deployment.reject',
      resource: request.params.id,
      result: 'success',
    });
    return reply.send(deployment);
  });

  app.post<{ Params: { id: string } }>('/api/deployments/:id/rollback', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'deployment.approve');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { reason?: unknown } | undefined;
    const deployment = await deployments.rollbackDeployment({
      tenantId: ctx.tenantId,
      deploymentId: request.params.id,
      reason: typeof body?.reason === 'string' ? body.reason : 'manual rollback',
    });
    if (!deployment) return reply.code(409).send({ error: 'deployment_not_rollbackable' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'deployment.rollback',
      resource: request.params.id,
      result: 'success',
    });
    return reply.send(deployment);
  });
}
