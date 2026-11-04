import type { Pool } from 'pg';
import { resourceFindings } from './resource-findings.js';

/** Emits and resolves agent resource threshold events from heartbeats. */
export class AgentResourceMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly intervalMs = Number.parseInt(process.env.OPSAGENT_RESOURCE_MONITOR_MS ?? '60000', 10),
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
      const agents = await this.pool.query<{
        id: string;
        tenant_id: string;
        hostname: string;
        metrics: Record<string, unknown> | null;
      }>(
        `SELECT id, tenant_id, hostname, metrics FROM agents
         WHERE status = 'online' AND last_seen > now() - interval '5 minutes'`,
      );
      for (const agent of agents.rows) {
        const findings = resourceFindings(agent.metrics);
        const fingerprints = new Set(findings.map((finding) => finding.fingerprint));
        for (const finding of findings) {
          const existing = await this.pool.query<{ id: string }>(
            `SELECT id FROM agent_events
             WHERE agent_id = $1 AND fingerprint = $2 AND status = 'open' LIMIT 1`,
            [agent.id, finding.fingerprint],
          );
          if (existing.rows[0]) {
            await this.pool.query(
              `UPDATE agent_events SET severity = $1, title = $2, detail = $3, metric = $4::jsonb
               WHERE id = $5`,
              [finding.severity, finding.title, finding.detail, JSON.stringify(finding.metric), existing.rows[0].id],
            );
          } else {
            await this.pool.query(
              `INSERT INTO agent_events (tenant_id, agent_id, fingerprint, severity, title, detail, metric)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
              [agent.tenant_id, agent.id, finding.fingerprint, finding.severity, finding.title, `${agent.hostname}: ${finding.detail}`, JSON.stringify(finding.metric)],
            );
            await this.pool.query(
              `INSERT INTO messages (tenant_id, title, body, severity)
               VALUES ($1, $2, $3, $4)`,
              [agent.tenant_id, finding.title, `${agent.hostname}: ${finding.detail}`, finding.severity],
            );
          }
        }
        for (const fingerprint of ['resource.memory', 'resource.disk']) {
          if (!fingerprints.has(fingerprint)) {
            await this.pool.query(
              `UPDATE agent_events SET status = 'resolved', resolved_at = now()
               WHERE agent_id = $1 AND fingerprint = $2 AND status = 'open'`,
              [agent.id, fingerprint],
            );
          }
        }
      }
    } catch (error) {
      console.error('agent resource monitor failed', error);
    } finally {
      this.running = false;
    }
  }
}
