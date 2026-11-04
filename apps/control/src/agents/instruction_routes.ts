import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';
import type { AuditWriter } from '../audit/writer.js';
import { AgentCommandService } from './commands.js';
import { planInstruction } from './instruction_planner.js';

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

interface InstructionDetailRow {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
  instruction: string | null;
  instruction_intent: Record<string, unknown> | null;
  created_at: Date;
  completed_at: Date | null;
}

async function loadInstruction(
  pool: Pool,
  tenantId: string,
  agentId: string,
  instructionId: string,
): Promise<InstructionDetailRow | null> {
  const result = await pool.query<InstructionDetailRow>(
    `SELECT id, status, result, instruction, instruction_intent, created_at, completed_at
     FROM agent_commands
     WHERE tenant_id = $1 AND agent_id = $2 AND id = $3 AND type = 'agent_instruction'`,
    [tenantId, agentId, instructionId],
  );
  return result.rows[0] ?? null;
}

function instructionResponse(row: InstructionDetailRow): Record<string, unknown> {
  const payload = row.result ?? {};
  return {
    instructionId: row.id,
    commandId: row.id,
    status: row.status,
    instruction: row.instruction,
    intent: row.instruction_intent,
    answer: typeof payload.answer === 'string' ? payload.answer : '',
    evidence: payload.evidence ?? null,
    toolsUsed: payload.toolsUsed ?? null,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export function registerAgentInstructionRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const commands = new AgentCommandService(pool);

  app.post('/api/agents/instructions', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { agentIds?: unknown; instruction?: unknown } | undefined;
    if (!Array.isArray(body?.agentIds) || typeof body.instruction !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const agentIds = [...new Set(body.agentIds.filter((id): id is string => typeof id === 'string'))];
    if (agentIds.length === 0 || agentIds.length > 8) {
      return reply.code(400).send({ error: 'invalid_agent_count' });
    }
    const plan = planInstruction(body.instruction);
    if (!plan.ok) return reply.code(400).send({ error: plan.error, message: plan.reason });

    const agents = await pool.query<{
      id: string;
      hostname: string;
      status: string;
      last_seen: Date;
    }>(
      `SELECT id, hostname, status, last_seen FROM agents
       WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [ctx.tenantId, agentIds],
    );
    if (agents.rows.length !== agentIds.length) {
      return reply.code(404).send({ error: 'agents_not_found' });
    }
    const offline = agents.rows.filter(
      (agent) => agent.status !== 'online' || agent.last_seen.getTime() < Date.now() - 90_000,
    );
    if (offline.length > 0) {
      return reply.code(409).send({
        error: 'agents_offline',
        agents: offline.map((agent) => ({ id: agent.id, hostname: agent.hostname })),
      });
    }

    const created = [];
    for (const agent of agents.rows) {
      const command = await commands.create({
        tenantId: ctx.tenantId,
        agentId: agent.id,
        type: 'agent_instruction',
        input: { instruction: body.instruction.trim(), intent: plan.intent, readOnly: true },
        requestedBy: ctx.userId,
        instruction: body.instruction.trim(),
        intent: plan.intent as unknown as Record<string, unknown>,
      });
      if (command) {
        created.push({ agentId: agent.id, hostname: agent.hostname, instructionId: command.id, status: command.status });
      }
    }
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'agent.instruction.batch',
      resource: created.map((item) => item.instructionId).join(','),
      result: 'success',
      metadata: { agentIds: created.map((item) => item.agentId), intent: plan.intent.kind },
    });
    return reply.code(202).send({ intent: plan.intent, instructions: created });
  });

  app.get('/api/agents/instruction-templates', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const result = await pool.query(
      `SELECT id, name, instruction, created_at FROM agent_instruction_templates
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [ctx.tenantId],
    );
    return reply.send(result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      instruction: row.instruction,
      createdAt: row.created_at.toISOString(),
    })));
  });

  app.post('/api/agents/instruction-templates', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { name?: unknown; instruction?: unknown } | undefined;
    if (typeof body?.name !== 'string' || typeof body.instruction !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const name = body.name.trim();
    const instruction = body.instruction.trim();
    if (!name || name.length > 80 || !instruction || instruction.length > 4000) {
      return reply.code(400).send({ error: 'invalid_template' });
    }
    try {
      const result = await pool.query(
        `INSERT INTO agent_instruction_templates (tenant_id, name, instruction, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, name, instruction, created_at`,
        [ctx.tenantId, name, instruction, ctx.userId],
      );
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'agent.instruction.template.create',
        resource: result.rows[0].id,
        result: 'success',
      });
      return reply.code(201).send({
        id: result.rows[0].id,
        name: result.rows[0].name,
        instruction: result.rows[0].instruction,
        createdAt: result.rows[0].created_at.toISOString(),
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        return reply.code(409).send({ error: 'template_exists' });
      }
      throw error;
    }
  });

  app.delete<{ Params: { templateId: string } }>('/api/agents/instruction-templates/:templateId', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const result = await pool.query(
      'DELETE FROM agent_instruction_templates WHERE tenant_id = $1 AND id = $2 RETURNING id',
      [ctx.tenantId, request.params.templateId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'template_not_found' });
    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'agent.instruction.template.delete',
      resource: request.params.templateId,
      result: 'success',
    });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/instructions', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as {
      instruction?: unknown;
      clientRequestId?: unknown;
    } | undefined;
    if (typeof body?.instruction !== 'string') return reply.code(400).send({ error: 'invalid_request' });
    const plan = planInstruction(body.instruction);
    if (!plan.ok) return reply.code(400).send({ error: plan.error, message: plan.reason });

    const agent = await pool.query<{
      hostname: string;
      status: string;
      last_seen: Date;
      app_system_id: string | null;
    }>(
      `SELECT hostname, status, last_seen, app_system_id FROM agents
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, request.params.id],
    );
    const target = agent.rows[0];
    if (!target) return reply.code(404).send({ error: 'agent_not_found' });
    if (target.status !== 'online' || target.last_seen.getTime() < Date.now() - 90_000) {
      return reply.code(409).send({ error: 'agent_offline', hostname: target.hostname });
    }

    const clientRequestId = typeof body.clientRequestId === 'string' && body.clientRequestId.length <= 100
      ? body.clientRequestId
      : undefined;
    if (clientRequestId) {
      const existing = await pool.query<{ id: string; status: string; instruction_intent: Record<string, unknown> | null }>(
        `SELECT id, status, instruction_intent FROM agent_commands
         WHERE tenant_id = $1 AND agent_id = $2 AND client_request_id = $3 LIMIT 1`,
        [ctx.tenantId, request.params.id, clientRequestId],
      );
      if (existing.rows[0]) {
        return reply.code(202).send({
          instructionId: existing.rows[0].id,
          commandId: existing.rows[0].id,
          agentId: request.params.id,
          hostname: target.hostname,
          status: existing.rows[0].status,
          intent: existing.rows[0].instruction_intent,
          idempotent: true,
        });
      }
    }

    const command = await commands.create({
      tenantId: ctx.tenantId,
      agentId: request.params.id,
      type: 'agent_instruction',
      input: {
        instruction: body.instruction.trim(),
        intent: plan.intent,
        readOnly: true,
      },
      requestedBy: ctx.userId,
      instruction: body.instruction.trim(),
      intent: plan.intent as unknown as Record<string, unknown>,
      ...(clientRequestId ? { clientRequestId } : {}),
    });
    if (!command) return reply.code(404).send({ error: 'agent_not_found' });

    await audit.write({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: 'agent.instruction.create',
      resource: command.id,
      result: 'success',
      metadata: { agentId: request.params.id, hostname: target.hostname, intent: plan.intent.kind },
    });

    return reply.code(202).send({
      instructionId: command.id,
      commandId: command.id,
      agentId: request.params.id,
      hostname: target.hostname,
      status: command.status,
      intent: plan.intent,
    });
  });

  app.get<{ Params: { id: string; instructionId: string } }>(
    '/api/agents/:id/instructions/:instructionId',
    async (request, reply) => {
      const ctx = await context(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'agent.manage');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }
      const row = await loadInstruction(pool, ctx.tenantId, request.params.id, request.params.instructionId);
      if (!row) return reply.code(404).send({ error: 'instruction_not_found' });
      return reply.send(instructionResponse(row));
    },
  );

  app.get<{ Params: { id: string } }>('/api/agents/:id/instructions', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const result = await pool.query<InstructionDetailRow>(
      `SELECT id, status, result, instruction, instruction_intent, created_at, completed_at
       FROM agent_commands
       WHERE tenant_id = $1 AND agent_id = $2 AND type = 'agent_instruction'
       ORDER BY created_at DESC LIMIT 20`,
      [ctx.tenantId, request.params.id],
    );
    return reply.send(result.rows.map(instructionResponse));
  });

  app.get<{ Params: { id: string; instructionId: string } }>(
    '/api/agents/:id/instructions/:instructionId/events',
    async (request, reply) => {
      const ctx = await context(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'agent.manage');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }
      const initial = await loadInstruction(pool, ctx.tenantId, request.params.id, request.params.instructionId);
      if (!initial) return reply.code(404).send({ error: 'instruction_not_found' });

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.flushHeaders?.();
      let closed = false;
      request.raw.on('close', () => {
        closed = true;
      });
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      send('status', { status: initial.status });
      const startedAt = Date.now();
      let finished = false;
      while (!closed && Date.now() - startedAt < 45_000) {
        const row = await loadInstruction(pool, ctx.tenantId, request.params.id, request.params.instructionId);
        if (!row) {
          send('error', { message: 'instruction_not_found' });
          finished = true;
          break;
        }
        if (row.status === 'completed' || row.status === 'failed') {
          const detail = instructionResponse(row);
          const answer = typeof detail.answer === 'string' ? detail.answer : '';
          for (let index = 0; index < answer.length && !closed; index += 80) {
            send('delta', { text: answer.slice(index, index + 80) });
            if (answer.length > 80) await sleep(8);
          }
          send('done', detail);
          finished = true;
          break;
        }
        send('status', { status: row.status });
        await sleep(1000);
      }
      if (!closed && !finished) send('error', { message: 'instruction_timeout' });
      reply.raw.end();
    },
  );
}
