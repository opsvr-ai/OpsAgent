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
    } catch (error) {
      console.error('agent instruction monitor failed', error);
    }
  }
}
