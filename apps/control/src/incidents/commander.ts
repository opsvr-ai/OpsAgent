import type { Pool } from 'pg';
import { IncidentService } from './service.js';

/**
 * Commander scheduler: picks up open incidents that have not been investigated
 * and runs the read-only host + connector evidence collection automatically.
 */
export class CommanderScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly active = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly incidents: IncidentService,
    private readonly intervalMs = 20_000,
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
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.pool.query<{ id: string; tenant_id: string }>(
        `SELECT i.id, i.tenant_id FROM incidents i
         WHERE i.status = 'open'
           AND i.source IN ('agent_health', 'alertmanager', 'zabbix', 'webhook')
           AND i.created_at < now() - interval '5 seconds'
           AND NOT EXISTS (
             SELECT 1 FROM incident_events e
             WHERE e.incident_id = i.id
               AND e.type IN ('investigation_started', 'investigation_skipped')
           )
         ORDER BY i.created_at ASC
         LIMIT 5`,
      );
      const tasks = candidates.rows
        .filter((row) => !this.active.has(row.id))
        .map(async (row) => {
          this.active.add(row.id);
          try {
            const user = await this.pool.query<{ id: string }>(
              `SELECT u.id FROM users u
               JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 AND m.status = 'active'
               ORDER BY u.created_at LIMIT 1`,
              [row.tenant_id],
            );
            const actorId = user.rows[0]?.id;
            if (!actorId) return;
            await this.incidents.investigate({
              tenantId: row.tenant_id,
              id: row.id,
              actorId,
            });
          } catch (error) {
            console.error('commander investigation failed', row.id, error);
          } finally {
            this.active.delete(row.id);
          }
        });
      await Promise.all(tasks);
    } catch (error) {
      console.error('commander scheduler tick failed', error);
    } finally {
      this.running = false;
    }
  }
}
