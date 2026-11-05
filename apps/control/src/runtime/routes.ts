import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PERMISSION_MODES, type PermissionMode, type RuntimeClient } from '@opsagent/contracts';
import type { ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { AuditWriter } from '../audit/writer.js';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { resolveTenantContext } from '../tenancy/context.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';

import { ApprovalNotFoundError, SessionNotFoundError, SessionService } from './session-service.js';

interface CreateSessionBody {
  tenantId?: unknown;
  roleView?: unknown;
  scenarioId?: unknown;
}

interface PromptBody {
  text?: unknown;
  idempotencyKey?: unknown;
  permissionMode?: unknown;
  modelId?: unknown;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

interface ApprovalBody {
  decision?: unknown;
  reason?: unknown;
}

function token(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE];
}

async function authContext(
  pool: Pool,
  request: FastifyRequest,
): Promise<{ userId: string; tenantId: string; roleView: string } | null> {
  const sessionToken = token(request);
  if (!sessionToken) return null;
  const session = await readSession(pool, sessionToken);
  if (!session) return null;
  if (!session.selectedTenantId) return null;
  const ctx = await resolveTenantContext(
    { userId: session.user.id, tenantId: session.selectedTenantId },
    createMembershipRepository(pool),
  );
  return { userId: session.user.id, tenantId: ctx.tenantId, roleView: ctx.roleView };
}

function sseWrite(raw: ServerResponse, event: unknown): void {
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerRuntimeRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
  runtime: RuntimeClient,
  modelSecret?: string,
): void {
  const sessions = new SessionService(pool, runtime, audit, modelSecret);

  app.get<{ Querystring: { sessionId?: string } }>('/api/approvals', async (request, reply) => {
    const auth = await authContext(pool, request);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(await sessions.listApprovals(auth.tenantId, auth.userId, request.query.sessionId));
  });

  app.get('/api/sessions', async (request, reply) => {
    const auth = await authContext(pool, request);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(await sessions.list(auth.tenantId, auth.userId));
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/transcript', async (request, reply) => {
    const auth = await authContext(pool, request);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const items = await sessions.transcript(request.params.id, auth.tenantId, auth.userId);
      return reply.send({ items });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      throw error;
    }
  });

  app.post('/api/sessions', async (request, reply) => {
    const auth = await authContext(pool, request);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });

    const body = request.body as CreateSessionBody | undefined;
    if (typeof body?.tenantId !== 'string' || typeof body.roleView !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (body.tenantId !== auth.tenantId) {
      return reply.code(403).send({ error: 'tenant_access_denied' });
    }

    const session = await sessions.create({
      tenantId: auth.tenantId,
      userId: auth.userId,
      roleView: body.roleView,
      ...(typeof body.scenarioId === 'string' ? { scenarioId: body.scenarioId } : {}),
    });
    return reply.code(201).send({ sessionId: session.id, roleView: session.roleView });
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/prompt', async (request, reply) => {
    const auth = await authContext(pool, request);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });

    const body = request.body as PromptBody | undefined;
    if (typeof body?.text !== 'string' || typeof body.idempotencyKey !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (body.permissionMode !== undefined && !isPermissionMode(body.permissionMode)) {
      return reply.code(400).send({ error: 'invalid_permission_mode' });
    }
    if (body.modelId !== undefined && (typeof body.modelId !== 'string' || body.modelId.length === 0)) {
      return reply.code(400).send({ error: 'invalid_model' });
    }

    const existing = await sessions.get(request.params.id, auth.tenantId, auth.userId);
    if (!existing) return reply.code(404).send({ error: 'session_not_found' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    try {
      for await (const event of sessions.prompt(
        request.params.id,
        auth.tenantId,
        auth.userId,
        body.text,
        body.idempotencyKey,
        body.permissionMode,
        typeof body.modelId === 'string' ? body.modelId : undefined,
      )) {
        sseWrite(reply.raw, event);
      }
    } catch (error) {
      request.log.error({
        err: error,
        sessionId: request.params.id,
        tenantId: auth.tenantId,
        event: 'runtime_prompt_failed',
      }, 'runtime prompt failed');
      sseWrite(reply.raw, {
        type: 'runtime.error',
        sessionId: request.params.id,
        at: new Date().toISOString(),
        code: error instanceof SessionNotFoundError ? 'session_not_found' : 'runtime_failed',
        message: error instanceof Error ? error.message : 'runtime failed',
      });
    } finally {
      reply.raw.end();
    }
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id', async (request, reply) => {
    const auth = await authContext(pool, request);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });

    const body = request.body as ApprovalBody | undefined;
    if (body?.decision !== 'approve' && body?.decision !== 'deny') {
      return reply.code(400).send({ error: 'invalid_decision' });
    }

    try {
      await sessions.respondApproval({
        approvalId: request.params.id,
        tenantId: auth.tenantId,
        userId: auth.userId,
        decision: body.decision,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) {
        return reply.code(404).send({ error: 'approval_not_found' });
      }
      throw error;
    }
    return reply.send({ ok: true });
  });
}
