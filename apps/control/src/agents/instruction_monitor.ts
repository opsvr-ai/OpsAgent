import type { Pool } from 'pg';

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
        service: string | null;
        instruction: string;
      }>(
        `UPDATE agent_instruction_approvals
         SET status = 'expired', decided_at = now()
         WHERE status = 'pending' AND expires_at < now()
         RETURNING tenant_id, id, service, instruction`,
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
      }
    } catch (error) {
      console.error('agent instruction monitor failed', error);
    }
  }
}
