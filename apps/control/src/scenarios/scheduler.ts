import type { ScenarioService } from './service.js';

export class ScenarioScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly scenarios: ScenarioService,
    private readonly intervalMs = 60_000,
  ) {}

  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let count = 0;
      for (const scenario of await this.scenarios.listDue(now)) {
        try {
          await this.scenarios.run(scenario.tenantId, scenario.id);
          count += 1;
        } catch {
          // A single failing scenario must not stop the scheduler.
        }
      }
      return count;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
