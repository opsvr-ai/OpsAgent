import type { Pool } from 'pg';
import { notifyApprovalWebhook } from './approval_webhook.js';

/** Expires pending/dispatched natural-language instructions after the signed command lifetime. */
export class AgentInstructionMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE agent_commands
         SET status = 'expired', completed_at = now()
         WHERE type = 'agent_instruction'
           AND status IN ('pending', 'dispatched')
           AND expires_at < now()`,
      );
      const expired = await this.pool.query<{
        tenant_id: string;
        id: string;
        agent_id: string;
        service: string | null;
        instruction: string;
      }>(
        `UPDATE agent_instruction_approvals
         SET status = 'expired', decided_at = now()
         WHERE status = 'pending' AND expires_at < now()
         RETURNING tenant_id, id, agent_id, service, instruction`,
      );
      for (const approval of expired.rows) {
        await this.pool.query(
          `INSERT INTO messages (tenant_id, title, body, severity)
           VALUES ($1, $2, $3, 'warning')`,
          [
            approval.tenant_id,
            'Agent 写操作审批已过期',
            `${approval.service ?? approval.instruction} 的审批已超过 24 小时，未执行。`,
          ],
        );
        notifyApprovalWebhook({
          type: 'approval_expired',
          tenantId: approval.tenant_id,
          approvalId: approval.id,
          agentId: approval.agent_id,
          service: approval.service,
          instruction: approval.instruction,
        }, this.pool);
      }

      const expiring = await this.pool.query<{
        tenant_id: string;
        id: string;
        agent_id: string;
        service: string | null;
        instruction: string;
        expires_at: Date;
      }>(
        `UPDATE agent_instruction_approvals
         SET reminded_at = now()
         WHERE status = 'pending' AND reminded_at IS NULL
           AND expires_at > now() AND expires_at <= now() + interval '1 hour'
         RETURNING tenant_id, id, agent_id, service, instruction, expires_at`,
      );
      for (const approval of expiring.rows) {
        await this.pool.query(
          `INSERT INTO messages (tenant_id, title, body, severity)
           VALUES ($1, $2, $3, 'warning')`,
          [
            approval.tenant_id,
            'Agent 写操作审批即将过期',
            `${approval.service ?? approval.instruction} 的审批将在 ${approval.expires_at.toISOString()} 过期，请及时处理。`,
          ],
        );
        notifyApprovalWebhook({
          type: 'approval_expiring',
          tenantId: approval.tenant_id,
          approvalId: approval.id,
          agentId: approval.agent_id,
          service: approval.service,
          instruction: approval.instruction,
        }, this.pool);
      }
    } catch (error) {
      console.error('agent instruction monitor failed', error);
    }
  }
}
