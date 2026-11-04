import type { Pool } from 'pg';
import { DeploymentService } from './service.js';

/**
 * Watches successfully deployed releases for new open agent events and
 * executes the signed rollback command automatically.
 */
export class DeploymentMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly deployments: DeploymentService,
    private readonly intervalMs = 30_000,
    private readonly autoPromoteSeconds = Number.parseInt(process.env.OPSAGENT_CANARY_AUTO_PROMOTE_SECONDS ?? '0', 10),
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
      const candidates = await this.pool.query<{ id: string; tenant_id: string; version: string }>(
        `SELECT d.id, d.tenant_id, r.version FROM deployments d
         JOIN releases r ON r.id = d.release_id
         WHERE d.status IN ('deployed', 'canary')
           AND d.finished_at IS NOT NULL
           AND d.finished_at < now() - interval '30 seconds'
           AND r.app_system_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM agent_events e
             JOIN agents a ON a.id = e.agent_id
             WHERE a.app_system_id = r.app_system_id AND a.tenant_id = d.tenant_id
               AND e.status = 'open' AND e.detected_at > d.finished_at
           )
         ORDER BY d.finished_at ASC LIMIT 5`,
      );
      for (const row of candidates.rows) {
        const rolledBack = await this.deployments.rollbackDeployment({
          tenantId: row.tenant_id,
          deploymentId: row.id,
          reason: `部署 ${row.version} 后出现新的 Agent 异常事件，自动回滚`,
        });
        if (rolledBack) {
          await this.pool.query(
            `INSERT INTO messages (tenant_id, title, body, severity)
             VALUES ($1, $2, $3, 'warning')`,
            [
              row.tenant_id,
              `部署自动回滚：${row.version}`,
              `部署后出现新异常事件，已执行 signed rollback。当前状态：${rolledBack.status}`,
            ],
          );
        }
      }
      if (this.autoPromoteSeconds > 0) {
        const stable = await this.pool.query<{ id: string; tenant_id: string; version: string }>(
          `SELECT d.id, d.tenant_id, r.version FROM deployments d
           JOIN releases r ON r.id = d.release_id
           WHERE d.status = 'canary'
             AND d.finished_at IS NOT NULL
             AND d.finished_at < now() - ($1 * interval '1 second')
             AND r.app_system_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM agent_events e
               JOIN agents a ON a.id = e.agent_id
               WHERE a.app_system_id = r.app_system_id AND a.tenant_id = d.tenant_id
                 AND e.status = 'open' AND e.detected_at > d.finished_at
             )
           ORDER BY d.finished_at ASC LIMIT 5`,
          [this.autoPromoteSeconds],
        );
        for (const row of stable.rows) {
          const promoted = await this.deployments.promoteDeployment(row.tenant_id, row.id);
          if (promoted) {
            await this.pool.query(
              `INSERT INTO messages (tenant_id, title, body, severity)
               VALUES ($1, $2, $3, 'info')`,
              [
                row.tenant_id,
                `灰度自动全量：${row.version}`,
                `灰度观察期结束且无新异常，状态：${promoted.status}`,
              ],
            );
          }
        }
      }
    } catch (error) {
      console.error('deployment monitor failed', error);
    } finally {
      this.running = false;
    }
  }
}
