import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import { ModelProviderService } from './service.js';
import { ModelCompletionService } from './completion.js';
import { discoverModels } from './discovery.js';

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

  app.post('/api/models/discover', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'model.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as {
      provider?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
    } | undefined;
    if (
      typeof body?.provider !== 'string' ||
      typeof body.baseUrl !== 'string' ||
      typeof body.apiKey !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      return reply.send({ models: await discoverModels({
        provider: body.provider,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
      }) });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'model_discovery_failed';
      request.log.warn({
        err: error,
        provider: body.provider,
        baseUrl: body.baseUrl,
        event: 'model_discovery_failed',
      }, 'model discovery failed');
      return reply.code(code === 'invalid_base_url' || code === 'unsupported_provider' ? 400 : 502)
        .send({ error: code === 'invalid_base_url' || code === 'unsupported_provider' ? code : 'model_discovery_failed' });
    }
  });

  // 模型连通性自检：用已保存的配置发一个小请求，返回真实错误原因，
  // 方便内网排查 401/404/超时/响应格式不兼容等问题。
  app.post<{ Params: { id: string } }>('/api/models/:id/test', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'model.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const list = await models.list(ctx.tenantId);
    const target = list.find((item) => item.id === request.params.id);
    if (!target) return reply.code(404).send({ error: 'model_not_found' });
    if (target.status !== 'active') return reply.code(409).send({ error: 'model_disabled' });
    const completion = new ModelCompletionService(models);
    const started = Date.now();
    try {
      const sample = await completion.complete({
        tenantId: ctx.tenantId,
        modelId: target.id,
        system: 'You are a connectivity probe. Reply with the single word: ok',
        prompt: 'ping',
        maxTokens: 16,
        timeoutMs: 20_000,
      });
      return reply.send({
        ok: true,
        model: target.model,
        latencyMs: Date.now() - started,
        sample: sample.trim().slice(0, 160),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'model_test_failed';
      request.log.warn({ err: error, modelId: target.id }, 'model connectivity test failed');
      return reply.code(502).send({ ok: false, error: message.slice(0, 300) });
    }
  });

  // 使用「拓扑分析同款」默认模型解析做连通性自检：与拓扑分析器完全一致的
  // tenant/model 选择逻辑，避免用户在多个模型间无法确认实际生效的是哪个。
  app.post('/api/models/test-default', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'model.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const resolved = await models.resolve(ctx.tenantId);
    if (!resolved) {
      return reply.code(409).send({ ok: false, error: 'model_not_configured' });
    }
    const completion = new ModelCompletionService(models);
    const started = Date.now();
    try {
      const sample = await completion.complete({
        tenantId: ctx.tenantId,
        system: 'You are a connectivity probe. Reply with the single word: ok',
        prompt: 'ping',
        maxTokens: 16,
        timeoutMs: 20_000,
      });
      return reply.send({
        ok: true,
        model: resolved.model,
        provider: resolved.provider,
        baseUrl: resolved.baseUrl,
        latencyMs: Date.now() - started,
        sample: sample.trim().slice(0, 160),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'model_test_failed';
      request.log.warn({ err: error, model: resolved.model }, 'default model connectivity test failed');
      return reply.code(502).send({ ok: false, error: message.slice(0, 300) });
    }
  });

  app.post('/api/models/batch', async (request, reply) => {    const ctx = await context(pool, request);
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
      models?: unknown;
      apiKey?: unknown;
    } | undefined;
    if (
      typeof body?.name !== 'string' ||
      typeof body.provider !== 'string' ||
      typeof body.baseUrl !== 'string' ||
      typeof body.apiKey !== 'string' ||
      !Array.isArray(body.models) ||
      body.models.length === 0 ||
      body.models.length > 100 ||
      !body.models.every((model) => typeof model === 'string' && model.trim().length > 0)
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const created = await models.createMany({
      tenantId: ctx.tenantId,
      name: body.name,
      provider: body.provider,
      baseUrl: body.baseUrl,
      models: body.models as string[],
      apiKey: body.apiKey,
    });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'model.create',
      resource: created[0]?.id ?? 'batch',
      result: 'success',
      metadata: { provider: body.provider, count: created.length, models: body.models },
    });
    return reply.code(201).send(created);
  });

  app.get('/api/models/available', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(await models.listAvailable(ctx.tenantId));
  });

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

  app.patch<{ Params: { id: string } }>('/api/models/:id', async (request, reply) => {
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
      status?: unknown;
    } | undefined;
    if (
      typeof body?.name !== 'string' ||
      typeof body.provider !== 'string' ||
      typeof body.baseUrl !== 'string' ||
      typeof body.model !== 'string' ||
      (body.apiKey !== undefined && typeof body.apiKey !== 'string') ||
      (body.status !== undefined && body.status !== 'active' && body.status !== 'disabled')
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const updated = await models.update(ctx.tenantId, request.params.id, {
      name: body.name,
      provider: body.provider,
      baseUrl: body.baseUrl,
      model: body.model,
      ...(typeof body.apiKey === 'string' && body.apiKey.length > 0 ? { apiKey: body.apiKey } : {}),
      ...(body.status === 'active' || body.status === 'disabled' ? { status: body.status } : {}),
    });
    if (!updated) return reply.code(404).send({ error: 'model_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'model.update',
      resource: updated.id,
      result: 'success',
      metadata: { provider: updated.provider, model: updated.model, name: updated.name, status: updated.status },
    });
    return reply.send(updated);
  });

  app.post<{ Params: { id: string } }>('/api/models/:id/default', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'model.configure');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const updated = await models.setAgentDefault(ctx.tenantId, request.params.id);
    if (!updated) return reply.code(404).send({ error: 'model_not_found_or_disabled' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'model.default',
      resource: updated.id,
      result: 'success',
      metadata: { name: updated.name, model: updated.model, provider: updated.provider },
    });
    return reply.send(updated);
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
