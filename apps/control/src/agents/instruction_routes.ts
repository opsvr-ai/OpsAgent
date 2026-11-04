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

export function registerAgentInstructionRoutes(
  app: FastifyInstance,
  pool: Pool,
  audit: AuditWriter,
): void {
  const commands = new AgentCommandService(pool);

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
      const result = await pool.query<{
        id: string;
        status: string;
        result: Record<string, unknown> | null;
        instruction: string | null;
        instruction_intent: Record<string, unknown> | null;
        created_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT id, status, result, instruction, instruction_intent, created_at, completed_at
         FROM agent_commands
         WHERE tenant_id = $1 AND agent_id = $2 AND id = $3 AND type = 'agent_instruction'`,
        [ctx.tenantId, request.params.id, request.params.instructionId],
      );
      const row = result.rows[0];
      if (!row) return reply.code(404).send({ error: 'instruction_not_found' });
      const payload = row.result ?? {};
      const answer = typeof payload.answer === 'string' ? payload.answer : '';
      return reply.send({
        instructionId: row.id,
        commandId: row.id,
        status: row.status,
        instruction: row.instruction,
        intent: row.instruction_intent,
        answer,
        evidence: payload.evidence ?? null,
        toolsUsed: payload.toolsUsed ?? null,
        createdAt: row.created_at.toISOString(),
        completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      });
    },
  );
}
