import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { CertificateRevocations } from '../src/agents/revocations.js';

describe('certificate revocations', () => {
  it('normalizes serial numbers and revokes immediately', async () => {
    const query = vi.fn(async () => ({ rows: [{ tls_cert_serial: 'AA:BB:CC' }] }));
    const revocations = new CertificateRevocations();
    revocations.start({ query } as unknown as Pool);
    await revocations.refresh();
    expect(revocations.isRevoked('aabbcc')).toBe(true);
    expect(revocations.isRevoked('ffffff')).toBe(false);
    revocations.stop();
  });

  it('adds a revoked serial from the update result', async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes('UPDATE')
        ? { rows: [{ tls_cert_serial: 'deadbeef' }] }
        : { rows: [] });
    const revocations = new CertificateRevocations();
    revocations.start({ query } as unknown as Pool);
    await revocations.refresh();
    expect(await revocations.revoke('agent-1', 'test')).toBe('deadbeef');
    expect(revocations.isRevoked('deadbeef')).toBe(true);
    revocations.stop();
  });
});
