import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext, type TenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';

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

export function registerAgentControlRoutes(app: FastifyInstance, pool: Pool): void {
  app.get<{ Params: { id: string } }>('/api/agent-control/tasks/:id', async (request, reply) => {
    const ctx = await context(pool, request);
    if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
    try {
      requirePermission(ctx, 'agent.manage');
    } catch (error) {
      if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
    const task = await pool.query(
      `SELECT id, instruction, target_mode, target_name, status, created_at, completed_at
       FROM agent_control_tasks WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, request.params.id],
    );
    const row = task.rows[0];
    if (!row) return reply.code(404).send({ error: 'task_not_found' });
    const runs = await pool.query(
      `SELECT hostname, status, answer, error, command_id, completed_at
       FROM agent_control_runs WHERE tenant_id = $1 AND task_id = $2 ORDER BY hostname`,
      [ctx.tenantId, request.params.id],
    );
    return reply.send({ ...row, runs: runs.rows });
  });
}
