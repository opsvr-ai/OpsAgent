import type { Pool } from 'pg';
import { certificateFinding } from './certificate-findings.js';

/** Emits/resolves agent client certificate expiry events. */
export class AgentCertificateMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly intervalMs = Number.parseInt(process.env.OPSAGENT_CERT_MONITOR_MS ?? '3600000', 10),
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
        tls_cert_expires_at: Date | null;
        tls_cert_serial: string | null;
      }>(
        `SELECT id, tenant_id, hostname, tls_cert_expires_at, tls_cert_serial
         FROM agents WHERE tls_cert_expires_at IS NOT NULL`,
      );
      for (const agent of agents.rows) {
        const finding = agent.tls_cert_expires_at ? certificateFinding(agent.tls_cert_expires_at) : null;
        const existing = await this.pool.query<{ id: string }>(
          `SELECT id FROM agent_events
           WHERE agent_id = $1 AND fingerprint = 'certificate.expiring' AND status = 'open' LIMIT 1`,
          [agent.id],
        );
        if (finding) {
          const detail = `${agent.hostname}: ${finding.detail}${agent.tls_cert_serial ? `（序列号 ${agent.tls_cert_serial}）` : ''}`;
          if (existing.rows[0]) {
            await this.pool.query(
              `UPDATE agent_events SET severity = $1, title = $2, detail = $3, metric = $4::jsonb
               WHERE id = $5`,
              [finding.severity, finding.title, detail, JSON.stringify({ expiresAt: agent.tls_cert_expires_at }), existing.rows[0].id],
            );
          } else {
            await this.pool.query(
              `INSERT INTO agent_events (tenant_id, agent_id, fingerprint, severity, title, detail, metric)
               VALUES ($1, $2, 'certificate.expiring', $3, $4, $5, $6::jsonb)`,
              [agent.tenant_id, agent.id, finding.severity, finding.title, detail, JSON.stringify({ expiresAt: agent.tls_cert_expires_at })],
            );
            await this.pool.query(
              `INSERT INTO messages (tenant_id, title, body, severity)
               VALUES ($1, $2, $3, $4)`,
              [agent.tenant_id, finding.title, detail, finding.severity],
            );
          }
        } else if (existing.rows[0]) {
          await this.pool.query(
            `UPDATE agent_events SET status = 'resolved', resolved_at = now() WHERE id = $1`,
            [existing.rows[0].id],
          );
        }
      }
    } catch (error) {
      console.error('agent certificate monitor failed', error);
    } finally {
      this.running = false;
    }
  }
}
