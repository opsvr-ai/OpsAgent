import type { Pool } from 'pg';

function normalize(serial: string | undefined): string {
  return (serial ?? '').replaceAll(':', '').toLowerCase();
}

/** Shared in-process set of revoked agent certificate serial numbers. */
export class CertificateRevocations {
  private readonly serials = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pool: Pool | undefined;

  start(pool: Pool): void {
    this.pool = pool;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    if (!this.pool) return;
    try {
      const result = await this.pool.query<{ tls_cert_serial: string | null }>(
        `SELECT tls_cert_serial FROM agents
         WHERE certificate_revoked_at IS NOT NULL AND tls_cert_serial IS NOT NULL`,
      );
      this.serials.clear();
      for (const row of result.rows) {
        if (row.tls_cert_serial) this.serials.add(normalize(row.tls_cert_serial));
      }
    } catch (error) {
      console.error('certificate revocation refresh failed', error);
    }
  }

  isRevoked(serial: string | undefined): boolean {
    const normalized = normalize(serial);
    return normalized.length > 0 && this.serials.has(normalized);
  }

  listSerials(): string[] {
    return [...this.serials];
  }

  async revoke(agentId: string, reason: string): Promise<string | null> {
    if (!this.pool) return null;
    const result = await this.pool.query<{ tls_cert_serial: string | null }>(
      `UPDATE agents SET certificate_revoked_at = now(), certificate_revoked_reason = $1
       WHERE id = $2 RETURNING tls_cert_serial`,
      [reason, agentId],
    );
    const serial = result.rows[0]?.tls_cert_serial ?? null;
    if (serial) this.serials.add(normalize(serial));
    return serial;
  }
}

export const certificateRevocations = new CertificateRevocations();
