import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { AgentSkillService } from './skills_service.js';

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

function validName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(value.trim());
}

export function registerAgentSkillRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const skills = new AgentSkillService(pool);

  app.get('/api/skills', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    return reply.send(await skills.list(ctx.tenantId));
  });

  app.post('/api/skills', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { name?: unknown; description?: unknown; content?: unknown } | undefined;
    if (!validName(body?.name) || typeof body.content !== 'string' || body.content.length > 64 * 1024) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const description = typeof body.description === 'string' ? body.description.slice(0, 500) : '';
    const skill = await skills.createCustom(ctx.tenantId, {
      name: body.name.trim(),
      description,
      content: body.content,
    });
    if (!skill) return reply.code(400).send({ error: 'name_conflicts_with_builtin' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'agent.skill.create',
      resource: skill.id,
      result: 'success',
      metadata: { name: skill.name },
    });
    return reply.code(201).send(skill);
  });

  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const removed = await skills.deleteCustom(ctx.tenantId, request.params.id);
    if (!removed) return reply.code(404).send({ error: 'custom_skill_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'agent.skill.delete',
      resource: request.params.id,
      result: 'success',
      metadata: {},
    });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/skills/:id/assign', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { scope?: unknown; targetId?: unknown } | undefined;
    if (body?.scope !== 'all' && body?.scope !== 'app_system' && body?.scope !== 'agent') {
      return reply.code(400).send({ error: 'invalid_scope' });
    }
    if (body.scope !== 'all' && typeof body.targetId !== 'string') {
      return reply.code(400).send({ error: 'target_required' });
    }
    const result = await skills.assign(
      ctx.tenantId,
      request.params.id,
      body.scope,
      typeof body.targetId === 'string' ? body.targetId : undefined,
    );
    if (!result) return reply.code(404).send({ error: 'skill_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'agent.skill.sync',
      resource: request.params.id,
      result: 'success',
      metadata: { scope: body.scope, targetId: body.targetId ?? null, synced: result.synced },
    });
    return reply.send(result);
  });
}
