import type { Pool } from 'pg';
import { notifyApprovalWebhook, replayApprovalWebhook } from './approval_webhook.js';
import { notifyOperationsAlert, replayOperationsAlert } from './operations_alert.js';

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

      const configuredOperationsReplays = Number.parseInt(process.env.OPSAGENT_OPERATIONS_ALERT_AUTO_REPLAYS ?? '3', 10);
      const maxOperationsReplays = Number.isFinite(configuredOperationsReplays)
        ? Math.min(Math.max(configuredOperationsReplays, 0), 5)
        : 3;
      const operationsReplay = await this.pool.query<{ id: string; payload: string }>(
        `UPDATE operations_alert_deliveries
         SET status = 'pending', attempts = 0, last_error = NULL,
             auto_replay_count = auto_replay_count + 1,
             next_auto_replay_at = NULL, updated_at = now()
         WHERE status = 'failed' AND auto_replay_count < $1
           AND (next_auto_replay_at IS NULL OR next_auto_replay_at <= now())
           AND created_at < now() - interval '1 minute'
         RETURNING id, payload::text AS payload`,
        [maxOperationsReplays],
      );
      for (const delivery of operationsReplay.rows) {
        replayOperationsAlert(this.pool, delivery.id, delivery.payload);
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

      const autoSideEffects = await this.pool.query<{
        id: string;
        approval_id: string;
        tenant_id: string;
        status: string;
        agent_id: string;
        hostname: string;
        instruction: string;
        action: string;
        service: string | null;
        incident_id: string | null;
        command_id: string | null;
      }>(
        `WITH claimed AS (
           UPDATE approval_side_effect_failures f
           SET auto_retry_count = f.auto_retry_count + 1,
               next_auto_retry_at = now() + interval '5 minutes'
           WHERE f.resolved_at IS NULL AND f.auto_retry_count < 2
             AND f.approval_id IS NOT NULL
             AND (f.next_auto_retry_at IS NULL OR f.next_auto_retry_at <= now())
             AND f.created_at < now() - interval '1 minute'
           RETURNING f.id, f.approval_id
         )
         SELECT c.id, c.approval_id, a.tenant_id, a.status, a.agent_id, g.hostname, a.instruction,
                a.action, a.service, a.incident_id, a.command_id
         FROM claimed c
         JOIN agent_instruction_approvals a ON a.id = c.approval_id
         JOIN agents g ON g.id = a.agent_id`,
      );
      for (const failure of autoSideEffects.rows) {
        try {
          if (failure.status === 'approved') {
            if (failure.incident_id) {
              await this.pool.query(
                `INSERT INTO incident_events (tenant_id, incident_id, actor_id, type, payload)
                 SELECT a.tenant_id, $1, a.requested_by, 'instruction_approval_approved', $2::jsonb
                 FROM agent_instruction_approvals a WHERE a.id = $3
                 AND NOT EXISTS (
                   SELECT 1 FROM incident_events
                   WHERE tenant_id = a.tenant_id AND incident_id = $1 AND type = 'instruction_approval_approved'
                     AND payload->>'approvalId' = $3
                 )`,
                [failure.incident_id, JSON.stringify({
                  approvalId: failure.approval_id,
                  commandId: failure.command_id,
                  service: failure.service,
                  autoRetried: true,
                }), failure.approval_id],
              );
            }
            await this.pool.query(
              `INSERT INTO messages (tenant_id, title, body, severity)
               SELECT tenant_id, 'Agent 写操作已批准', $1, 'info'
               FROM agent_instruction_approvals WHERE id = $2`,
              [`${failure.hostname}：${failure.action} ${failure.service ?? ''}`, failure.approval_id],
            );
            notifyApprovalWebhook({
              type: 'approval_approved',
              tenantId: failure.tenant_id,
              approvalId: failure.approval_id,
              agentId: failure.agent_id,
              hostname: failure.hostname,
              action: failure.action,
              service: failure.service,
              instruction: failure.instruction,
            });
          } else if (failure.status === 'denied') {
            await this.pool.query(
              `INSERT INTO messages (tenant_id, title, body, severity)
               SELECT tenant_id, 'Agent 写操作已拒绝', $1, 'info'
               FROM agent_instruction_approvals WHERE id = $2`,
              [failure.service ?? failure.instruction, failure.approval_id],
            );
            notifyApprovalWebhook({
              type: 'approval_denied',
              tenantId: failure.tenant_id,
              approvalId: failure.approval_id,
              agentId: failure.agent_id,
              hostname: failure.hostname,
              action: failure.action,
              service: failure.service,
              instruction: failure.instruction,
            });
          }
          await this.pool.query(
            `UPDATE approval_side_effect_failures SET resolved_at = now() WHERE id = $1`,
            [failure.id],
          );
        } catch (error) {
          console.error('approval side effect auto retry failed', failure.id, error);
        }
      }

      const configuredRetention = Number.parseInt(process.env.OPSAGENT_APPROVAL_HISTORY_RETENTION_DAYS ?? '30', 10);
      const retentionDays = Number.isFinite(configuredRetention)
        ? Math.min(Math.max(configuredRetention, 7), 365)
        : 30;
      await this.pool.query(
        `INSERT INTO approval_notification_archive (tenant_id, kind, payload)
         SELECT tenant_id, 'approval_webhook', to_jsonb(d)
         FROM approval_webhook_deliveries d
         WHERE status = 'delivered' AND created_at < now() - make_interval(days => $1)`,
        [retentionDays],
      );
      await this.pool.query(
        `DELETE FROM approval_webhook_deliveries
         WHERE status = 'delivered' AND created_at < now() - make_interval(days => $1)`,
        [retentionDays],
      );
      await this.pool.query(
        `INSERT INTO approval_notification_archive (tenant_id, kind, payload)
         SELECT tenant_id, 'operations_alert', to_jsonb(d)
         FROM operations_alert_deliveries d
         WHERE status = 'delivered' AND created_at < now() - make_interval(days => $1)`,
        [retentionDays],
      );
      await this.pool.query(
        `DELETE FROM operations_alert_deliveries
         WHERE status = 'delivered' AND created_at < now() - make_interval(days => $1)`,
        [retentionDays],
      );
      await this.pool.query(
        `INSERT INTO approval_notification_archive (tenant_id, kind, payload)
         SELECT tenant_id, 'side_effect_failure', to_jsonb(f)
         FROM approval_side_effect_failures f
         WHERE resolved_at IS NOT NULL AND created_at < now() - make_interval(days => $1)`,
        [retentionDays],
      );
      await this.pool.query(
        `DELETE FROM approval_side_effect_failures
         WHERE resolved_at IS NOT NULL AND created_at < now() - make_interval(days => $1)`,
        [retentionDays],
      );
    } catch (error) {
      console.error('agent instruction monitor failed', error);
    }
  }
}
