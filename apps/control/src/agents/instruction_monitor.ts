import type { Pool } from 'pg';
import { notifyApprovalWebhook, replayApprovalWebhook } from './approval_webhook.js';
import { notifyOperationsAlert } from './operations_alert.js';

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

      const configuredReplays = Number.parseInt(process.env.OPSAGENT_APPROVAL_WEBHOOK_AUTO_REPLAYS ?? '3', 10);
      const maxAutoReplays = Number.isFinite(configuredReplays) ? Math.min(Math.max(configuredReplays, 0), 5) : 3;
      const autoReplay = await this.pool.query<{ id: string; payload: string }>(
        `UPDATE approval_webhook_deliveries
         SET status = 'pending', attempts = 0, last_error = NULL,
             auto_replay_count = auto_replay_count + 1,
             next_auto_replay_at = NULL, updated_at = now()
         WHERE status = 'failed' AND auto_replay_count < $1
           AND (next_auto_replay_at IS NULL OR next_auto_replay_at <= now())
           AND created_at < now() - interval '1 minute'
         RETURNING id, payload::text AS payload`,
        [maxAutoReplays],
      );
      for (const delivery of autoReplay.rows) {
        replayApprovalWebhook(this.pool, delivery.id, delivery.payload);
      }

      const configuredThreshold = Number.parseInt(process.env.OPSAGENT_APPROVAL_WEBHOOK_ALERT_THRESHOLD ?? '5', 10);
      const threshold = Number.isFinite(configuredThreshold) ? Math.max(configuredThreshold, 1) : 5;
      const failedByTenant = await this.pool.query<{ tenant_id: string; failed_count: string }>(
        `SELECT tenant_id, count(*)::text AS failed_count
         FROM approval_webhook_deliveries
         WHERE status = 'failed'
         GROUP BY tenant_id
         HAVING count(*) >= $1`,
        [threshold],
      );
      for (const row of failedByTenant.rows) {
        const alerted = await this.pool.query<{ tenant_id: string }>(
          `INSERT INTO approval_webhook_alert_state (tenant_id, last_alert_at, failed_count, alert_active)
           VALUES ($1, now(), $2, true)
           ON CONFLICT (tenant_id) DO UPDATE
             SET last_alert_at = now(), failed_count = EXCLUDED.failed_count, alert_active = true
             WHERE approval_webhook_alert_state.last_alert_at < now() - interval '1 hour'
           RETURNING tenant_id`,
          [row.tenant_id, Number(row.failed_count)],
        );
        if (!alerted.rows[0]) continue;
        await this.pool.query(
          `INSERT INTO messages (tenant_id, title, body, severity)
           VALUES ($1, '审批 Webhook 连续投递失败', $2, 'warning')`,
          [row.tenant_id, `${row.failed_count} 条投递失败，请检查 Webhook 配置或下游服务。`],
        );
        notifyOperationsAlert({
          tenantId: row.tenant_id,
          title: '审批 Webhook 连续投递失败',
          body: `${row.failed_count} 条投递失败，请检查 Webhook 配置或下游服务。`,
          severity: 'warning',
        }, this.pool);
      }

      const recovered = await this.pool.query<{ tenant_id: string; failed_count: string }>(
        `SELECT s.tenant_id, count(d.id)::text AS failed_count
         FROM approval_webhook_alert_state s
         LEFT JOIN approval_webhook_deliveries d
           ON d.tenant_id = s.tenant_id AND d.status = 'failed'
         WHERE s.alert_active = true
         GROUP BY s.tenant_id
         HAVING count(d.id) < $1`,
        [threshold],
      );
      for (const row of recovered.rows) {
        await this.pool.query(
          `UPDATE approval_webhook_alert_state
           SET alert_active = false, failed_count = $1
           WHERE tenant_id = $2`,
          [Number(row.failed_count), row.tenant_id],
        );
        await this.pool.query(
          `INSERT INTO messages (tenant_id, title, body, severity)
           VALUES ($1, '审批 Webhook 投递已恢复', $2, 'info')`,
          [row.tenant_id, `剩余失败投递 ${row.failed_count} 条，已低于告警阈值。`],
        );
        notifyOperationsAlert({
          tenantId: row.tenant_id,
          title: '审批 Webhook 投递已恢复',
          body: `剩余失败投递 ${row.failed_count} 条，已低于告警阈值。`,
          severity: 'info',
        }, this.pool);
      }
    } catch (error) {
      console.error('agent instruction monitor failed', error);
    }
  }
}
