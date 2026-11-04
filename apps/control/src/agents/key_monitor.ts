import type { Pool } from 'pg';
import { getCommandSigners } from './signing.js';

/**
 * Watches active agents for command signing keys that are no longer accepted.
 * Emits at most one warning message per tenant per day.
 */
export class AgentKeyMonitor {
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
    const keyIds = getCommandSigners().map((signer) => signer.keyId);
    if (keyIds.length === 0) return;
    try {
      const stale = await this.pool.query<{ tenant_id: string; hostname: string }>(
        `SELECT tenant_id, hostname FROM agents
         WHERE command_key_id IS NOT NULL
           AND NOT (command_key_id = ANY($1::text[]))
           AND last_seen > now() - interval '5 minutes'
         ORDER BY tenant_id, hostname`,
        [keyIds],
      );
      const byTenant = new Map<string, string[]>();
      for (const row of stale.rows) {
        const list = byTenant.get(row.tenant_id) ?? [];
        list.push(row.hostname);
        byTenant.set(row.tenant_id, list);
      }
      for (const [tenantId, hostnames] of byTenant) {
        const recent = await this.pool.query(
          `SELECT 1 FROM messages
           WHERE tenant_id = $1 AND title LIKE 'Agent 命令密钥待更新%'
             AND created_at > now() - interval '1 day' LIMIT 1`,
          [tenantId],
        );
        if (recent.rows[0]) continue;
        await this.pool.query(
          `INSERT INTO messages (tenant_id, title, body, severity)
           VALUES ($1, $2, $3, 'warning')`,
          [
            tenantId,
            `Agent 命令密钥待更新（${hostnames.length} 台）`,
            `以下 Agent 最近心跳仍使用已撤销的命令密钥：${hostnames.slice(0, 10).join('、')}${hostnames.length > 10 ? ' 等' : ''}。请确认其心跳是否正常。`,
          ],
        );
      }
    } catch (error) {
      console.error('agent key monitor failed', error);
    }
  }
}
