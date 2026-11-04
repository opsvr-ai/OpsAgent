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
  agent_id: string;
  status: string;
  result: Record<string, unknown> | null;
  instruction: string | null;
  instruction_intent: Record<string, unknown> | null;
  requested_by: string | null;
  incident_id: string | null;
  incident_linked_at: Date | null;
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
    `SELECT id, agent_id, status, result, instruction, instruction_intent, requested_by,
            incident_id, incident_linked_at, created_at, completed_at
     FROM agent_commands
     WHERE tenant_id = $1 AND agent_id = $2 AND id = $3 AND type = 'agent_instruction'`,
    [tenantId, agentId, instructionId],
  );
  return result.rows[0] ?? null;
}

async function linkInstructionToIncident(
  pool: Pool,
  tenantId: string,
  row: InstructionDetailRow,
  actorId: string,
): Promise<void> {
  if (!row.incident_id || row.incident_linked_at || !['completed', 'failed'].includes(row.status)) return;
  const claim = await pool.query(
    `UPDATE agent_commands SET incident_linked_at = now()
     WHERE id = $1 AND tenant_id = $2 AND incident_linked_at IS NULL RETURNING id`,
    [row.id, tenantId],
  );
  if (!claim.rows[0]) return;
  const payload = row.result ?? {};
  const answer = typeof payload.answer === 'string' ? payload.answer : '';
  const summary = answer.length > 1200 ? `${answer.slice(0, 1200)}\n…` : answer || `指令状态 ${row.status}`;
  await pool.query(
    `INSERT INTO incident_evidence (tenant_id, incident_id, kind, source, summary, payload)
     VALUES ($1, $2, 'agent_instruction', 'opsagent-agent', $3, $4::jsonb)`,
    [tenantId, row.incident_id, summary, JSON.stringify({
      commandId: row.id,
      instruction: row.instruction,
      status: row.status,
      intent: row.instruction_intent,
      answer,
      evidence: payload.evidence ?? null,
      toolsUsed: payload.toolsUsed ?? null,
    })],
  );
  await pool.query(
    `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
     VALUES ($1, $2, $3, 'instruction_completed', $4::jsonb)`,
    [tenantId, row.incident_id, row.requested_by ?? actorId, JSON.stringify({
      commandId: row.id,
      agentId: row.agent_id,
      status: row.status,
    })],
  );
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

    if (!plan.intent.readOnly) {
      const service = plan.intent.params.service;
      if (!service) return reply.code(400).send({ error: 'unsupported_instruction' });
      const approvals = [];
      for (const agent of agents.rows) {
        const approval = await pool.query<{ id: string; status: string }>(
          `INSERT INTO agent_instruction_approvals
             (tenant_id, agent_id, instruction, action, service, risk, requested_by)
           VALUES ($1, $2, $3, $4, $5, 'R2', $6)
           RETURNING id, status`,
          [ctx.tenantId, agent.id, body.instruction.trim(), plan.intent.kind, service, ctx.userId],
        );
        const row = approval.rows[0];
        if (row) approvals.push({ approvalId: row.id, agentId: agent.id, hostname: agent.hostname, status: 'awaiting_approval' });
      }
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'agent.instruction.batch',
        resource: approvals.map((item) => item.approvalId).join(','),
        result: 'success',
        metadata: { agentIds: agentIds, intent: plan.intent.kind, approvals: approvals.length },
      });
      return reply.code(202).send({ intent: plan.intent, approvals });
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
      `SELECT id, name, instruction, scope, created_at FROM agent_instruction_templates
       WHERE tenant_id = $1 AND (scope = 'tenant' OR created_by = $2)
       ORDER BY created_at DESC`,
      [ctx.tenantId, ctx.userId],
    );
    return reply.send(result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      instruction: row.instruction,
      scope: row.scope,
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
    const body = request.body as { name?: unknown; instruction?: unknown; scope?: unknown } | undefined;
    if (typeof body?.name !== 'string' || typeof body.instruction !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const name = body.name.trim();
    const instruction = body.instruction.trim();
    const scope = body.scope === 'private' ? 'private' : 'tenant';
    if (!name || name.length > 80 || !instruction || instruction.length > 4000) {
      return reply.code(400).send({ error: 'invalid_template' });
    }
    try {
      const result = await pool.query(
        `INSERT INTO agent_instruction_templates (tenant_id, name, instruction, scope, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name, instruction, scope, created_at`,
        [ctx.tenantId, name, instruction, scope, ctx.userId],
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
        scope: result.rows[0].scope,
        createdAt: result.rows[0].created_at.toISOString(),
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        return reply.code(409).send({ error: 'template_exists' });
      }
      throw error;
    }
  });

  app.put<{ Params: { templateId: string } }>('/api/agents/instruction-templates/:templateId', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as { name?: unknown; instruction?: unknown; scope?: unknown } | undefined;
    if (typeof body?.name !== 'string' || typeof body.instruction !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const name = body.name.trim();
    const instruction = body.instruction.trim();
    const scope = body.scope === 'private' ? 'private' : body.scope === 'tenant' ? 'tenant' : null;
    if (!name || name.length > 80 || !instruction || instruction.length > 4000) {
      return reply.code(400).send({ error: 'invalid_template' });
    }
    try {
      const result = await pool.query(
        `UPDATE agent_instruction_templates SET name = $1, instruction = $2, scope = COALESCE($3, scope)
         WHERE tenant_id = $4 AND id = $5 AND (scope = 'tenant' OR created_by = $6)
         RETURNING id, name, instruction, scope, created_at`,
        [name, instruction, scope, ctx.tenantId, request.params.templateId, ctx.userId],
      );
      if (!result.rows[0]) return reply.code(404).send({ error: 'template_not_found' });
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'agent.instruction.template.update',
        resource: request.params.templateId,
        result: 'success',
      });
      return reply.send({
        id: result.rows[0].id,
        name: result.rows[0].name,
        instruction: result.rows[0].instruction,
        scope: result.rows[0].scope,
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
      `DELETE FROM agent_instruction_templates
       WHERE tenant_id = $1 AND id = $2 AND (scope = 'tenant' OR created_by = $3) RETURNING id`,
      [ctx.tenantId, request.params.templateId, ctx.userId],
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

  app.get<{ Querystring: { status?: string } }>('/api/agent-instruction-approvals', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'approval.decide');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const decided = request.query.status === 'decided';
    const result = await pool.query<{
      id: string;
      agent_id: string;
      hostname: string;
      instruction: string;
      action: string;
      service: string | null;
      risk: string;
      status: string;
      requested_by: string;
      decided_by: string | null;
      decision_reason: string | null;
      command_id: string | null;
      created_at: Date;
      decided_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT a.id, a.agent_id, g.hostname, a.instruction, a.action, a.service, a.risk, a.status,
              a.requested_by, a.decided_by, a.decision_reason, a.command_id, a.created_at, a.decided_at, a.expires_at
       FROM agent_instruction_approvals a JOIN agents g ON g.id = a.agent_id
       WHERE a.tenant_id = $1 AND a.status = ANY($2::text[])
         AND (a.status <> 'pending' OR a.expires_at > now())
       ORDER BY a.created_at DESC
       LIMIT 50`,
      [ctx.tenantId, decided ? ['approved', 'denied', 'canceled', 'expired'] : ['pending']],
    );
    return reply.send(result.rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      hostname: row.hostname,
      instruction: row.instruction,
      action: row.action,
      service: row.service,
      risk: row.risk,
      status: row.status,
      requestedBy: row.requested_by,
      decidedBy: row.decided_by,
      decisionReason: row.decision_reason,
      commandId: row.command_id,
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
      expiresAt: row.expires_at.toISOString(),
    })));
  });

  app.post<{ Params: { approvalId: string } }>(
    '/api/agent-instruction-approvals/:approvalId/decision',
    async (request, reply) => {
      const ctx = await context(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'approval.decide');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }
      const body = request.body as { decision?: unknown; reason?: unknown } | undefined;
      if (body?.decision !== 'approve' && body?.decision !== 'deny') {
        return reply.code(400).send({ error: 'invalid_decision' });
      }
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
      const row = await pool.query<{
        id: string;
        agent_id: string;
        instruction: string;
        action: string;
        service: string | null;
        requested_by: string;
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, agent_id, instruction, action, service, requested_by, status, expires_at
         FROM agent_instruction_approvals
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
        [ctx.tenantId, request.params.approvalId],
      );
      const approval = row.rows[0];
      if (!approval) return reply.code(409).send({ error: 'approval_not_pending' });
      if (body.decision === 'approve'
        && process.env.OPSAGENT_REQUIRE_SEPARATION_OF_DUTIES === 'true'
        && approval.requested_by === ctx.userId) {
        return reply.code(403).send({ error: 'self_approval_forbidden' });
      }
      if (approval.expires_at.getTime() <= Date.now()) {
        await pool.query(
          `UPDATE agent_instruction_approvals SET status = 'expired', decided_at = now()
           WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
          [ctx.tenantId, approval.id],
        );
        return reply.code(409).send({ error: 'approval_expired' });
      }

      if (body.decision === 'deny') {
        await pool.query(
          `UPDATE agent_instruction_approvals
           SET status = 'denied', decided_by = $1, decided_at = now(), decision_reason = $2
           WHERE tenant_id = $3 AND id = $4`,
          [ctx.userId, reason, ctx.tenantId, approval.id],
        );
        await audit.write({
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'agent.instruction.approval.denied',
          resource: approval.id,
          result: 'success',
          metadata: { agentId: approval.agent_id, service: approval.service },
        });
        return reply.send({ status: 'denied', approvalId: approval.id });
      }

      const agent = await pool.query<{ hostname: string; status: string; last_seen: Date }>(
        'SELECT hostname, status, last_seen FROM agents WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, approval.agent_id],
      );
      const target = agent.rows[0];
      if (!target) return reply.code(404).send({ error: 'agent_not_found' });
      if (target.status !== 'online' || target.last_seen.getTime() < Date.now() - 90_000) {
        return reply.code(409).send({ error: 'agent_offline', hostname: target.hostname });
      }
      const service = approval.service ?? '';
      const intentKind = approval.action === 'service_stop' ? 'service_stop' : 'service_restart';
      const command = await commands.create({
        tenantId: ctx.tenantId,
        agentId: approval.agent_id,
        type: 'agent_instruction',
        input: {
          instruction: approval.instruction,
          intent: {
            kind: intentKind,
            params: { service },
            readOnly: false,
            risk: 'R2',
          },
          readOnly: false,
        },
        requestedBy: approval.requested_by,
        instruction: approval.instruction,
        intent: {
          kind: intentKind,
          params: { service },
          readOnly: false,
          risk: 'R2',
        },
      });
      if (!command) return reply.code(404).send({ error: 'agent_not_found' });
      await pool.query(
        `UPDATE agent_instruction_approvals
         SET status = 'approved', decided_by = $1, decided_at = now(),
             decision_reason = $2, command_id = $3
         WHERE tenant_id = $4 AND id = $5`,
        [ctx.userId, reason, command.id, ctx.tenantId, approval.id],
      );
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'agent.instruction.approval.approved',
        resource: approval.id,
        result: 'success',
        metadata: { agentId: approval.agent_id, service, commandId: command.id },
      });
      return reply.code(202).send({
        status: 'approved',
        approvalId: approval.id,
        instructionId: command.id,
        agentId: approval.agent_id,
        hostname: target.hostname,
      });
    },
  );

  app.post<{ Params: { approvalId: string } }>(
    '/api/agent-instruction-approvals/:approvalId/cancel',
    async (request, reply) => {
      const ctx = await context(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'agent.manage');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }
      const row = await pool.query<{ id: string; requested_by: string; status: string }>(
        `SELECT id, requested_by, status FROM agent_instruction_approvals
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, request.params.approvalId],
      );
      const approval = row.rows[0];
      if (!approval || approval.status !== 'pending') return reply.code(409).send({ error: 'approval_not_pending' });
      if (approval.requested_by !== ctx.userId) return reply.code(403).send({ error: 'requester_only' });
      await pool.query(
        `UPDATE agent_instruction_approvals
         SET status = 'canceled', decided_by = $1, decided_at = now()
         WHERE tenant_id = $2 AND id = $3 AND status = 'pending'`,
        [ctx.userId, ctx.tenantId, approval.id],
      );
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'agent.instruction.approval.canceled',
        resource: approval.id,
        result: 'success',
      });
      return reply.send({ status: 'canceled', approvalId: approval.id });
    },
  );

  app.post('/api/agent-instruction-approvals/batch-decision', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'approval.decide');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const body = request.body as {
      approvalIds?: unknown;
      decision?: unknown;
      reason?: unknown;
    } | undefined;
    if (!Array.isArray(body?.approvalIds) || (body.decision !== 'approve' && body.decision !== 'deny')) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const approvalIds = [...new Set(body.approvalIds.filter((id): id is string => typeof id === 'string'))];
    if (approvalIds.length === 0 || approvalIds.length > 20) {
      return reply.code(400).send({ error: 'invalid_approval_count' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
    const preflight = await pool.query<{
      id: string;
      status: string;
      expires_at: Date;
      requested_by: string;
      hostname: string;
      agent_status: string;
      last_seen: Date;
    }>(
      `SELECT a.id, a.status, a.expires_at, a.requested_by, g.hostname, g.status AS agent_status, g.last_seen
       FROM agent_instruction_approvals a JOIN agents g ON g.id = a.agent_id
       WHERE a.tenant_id = $1 AND a.id = ANY($2::uuid[])`,
      [ctx.tenantId, approvalIds],
    );
    const byId = new Map(preflight.rows.map((row) => [row.id, row]));
    const failures = approvalIds.flatMap((approvalId) => {
      const row = byId.get(approvalId);
      if (!row) return [{ approvalId, reason: 'not_found' }];
      if (row.status !== 'pending') return [{ approvalId, reason: 'not_pending' }];
      if (row.expires_at.getTime() <= Date.now()) return [{ approvalId, reason: 'expired' }];
      if (body.decision === 'approve'
        && process.env.OPSAGENT_REQUIRE_SEPARATION_OF_DUTIES === 'true'
        && row.requested_by === ctx.userId) {
        return [{ approvalId, reason: 'self_approval_forbidden' }];
      }
      if (body.decision === 'approve'
        && (row.agent_status !== 'online' || row.last_seen.getTime() < Date.now() - 90_000)) {
        return [{ approvalId, reason: 'agent_offline' }];
      }
      return [];
    });
    if (failures.length > 0) {
      return reply.code(409).send({ error: 'batch_preflight_failed', failures });
    }
    const results = [];
    for (const approvalId of approvalIds) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/agent-instruction-approvals/${encodeURIComponent(approvalId)}/decision`,
        headers: { cookie: request.headers.cookie ?? '' },
        payload: { decision: body.decision, ...(reason ? { reason } : {}) },
      });
      let result: Record<string, unknown>;
      try { result = response.json() as Record<string, unknown>; } catch { result = { error: 'invalid_response' }; }
      results.push({ approvalId, statusCode: response.statusCode, result });
    }
    return reply.send({ results });
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
      incidentId?: unknown;
    } | undefined;
    if (typeof body?.instruction !== 'string') return reply.code(400).send({ error: 'invalid_request' });
    const plan = planInstruction(body.instruction);
    if (!plan.ok) return reply.code(400).send({ error: plan.error, message: plan.reason });

    let incidentId: string | undefined;
    if (typeof body.incidentId === 'string') {
      const incident = await pool.query('SELECT 1 FROM incidents WHERE id = $1 AND tenant_id = $2', [
        body.incidentId,
        ctx.tenantId,
      ]);
      if (!incident.rows[0]) return reply.code(404).send({ error: 'incident_not_found' });
      incidentId = body.incidentId;
    }

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

    if (!plan.intent.readOnly) {
      const service = plan.intent.params.service;
      if (!service) return reply.code(400).send({ error: 'unsupported_instruction' });
      const approval = await pool.query<{ id: string; status: string; created_at: Date }>(
        `INSERT INTO agent_instruction_approvals
           (tenant_id, agent_id, instruction, action, service, risk, requested_by)
         VALUES ($1, $2, $3, $4, $5, 'R2', $6)
         RETURNING id, status, created_at`,
        [ctx.tenantId, request.params.id, body.instruction.trim(), plan.intent.kind, service, ctx.userId],
      );
      const createdApproval = approval.rows[0];
      if (!createdApproval) return reply.code(500).send({ error: 'approval_create_failed' });
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'agent.instruction.approval.requested',
        resource: createdApproval.id,
        result: 'success',
        metadata: { agentId: request.params.id, hostname: target.hostname, service },
      });
      return reply.code(202).send({
        approvalId: createdApproval.id,
        status: 'awaiting_approval',
        agentId: request.params.id,
        hostname: target.hostname,
        intent: plan.intent,
        createdAt: createdApproval.created_at.toISOString(),
      });
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
      ...(incidentId ? { incidentId } : {}),
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
      ...(incidentId ? { incidentId } : {}),
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
      await linkInstructionToIncident(pool, ctx.tenantId, row, ctx.userId);
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
      `SELECT id, agent_id, status, result, instruction, instruction_intent, requested_by,
              incident_id, incident_linked_at, created_at, completed_at
       FROM agent_commands
       WHERE tenant_id = $1 AND agent_id = $2 AND type = 'agent_instruction'
       ORDER BY created_at DESC LIMIT 20`,
      [ctx.tenantId, request.params.id],
    );
    return reply.send(result.rows.map(instructionResponse));
  });

  app.post<{ Params: { id: string; instructionId: string } }>(
    '/api/agents/:id/instructions/:instructionId/cancel',
    async (request, reply) => {
      const ctx = await context(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'agent.manage');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }
      const result = await pool.query<{ id: string }>(
        `UPDATE agent_commands SET status = 'canceled', completed_at = now()
         WHERE tenant_id = $1 AND agent_id = $2 AND id = $3 AND type = 'agent_instruction'
           AND status IN ('pending', 'dispatched')
         RETURNING id`,
        [ctx.tenantId, request.params.id, request.params.instructionId],
      );
      if (!result.rows[0]) return reply.code(409).send({ error: 'instruction_not_cancelable' });
      await audit.write({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'agent.instruction.cancel',
        resource: request.params.instructionId,
        result: 'success',
        metadata: { agentId: request.params.id },
      });
      return reply.send({ ok: true, instructionId: request.params.instructionId, status: 'canceled' });
    },
  );

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
      reply.raw.write('retry: 2000\n\n');
      let closed = false;
      let eventId = 0;
      request.raw.on('close', () => {
        closed = true;
      });
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        eventId += 1;
        reply.raw.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
        if (['completed', 'failed', 'canceled', 'expired'].includes(row.status)) {
          await linkInstructionToIncident(pool, ctx.tenantId, row, ctx.userId);
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
