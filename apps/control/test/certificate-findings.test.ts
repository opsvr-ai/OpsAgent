import { describe, expect, it } from 'vitest';
import { certificateFinding } from '../src/agents/certificate-findings.js';

const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-04T00:00:00Z');

describe('certificate findings', () => {
  it('marks certificates inside 7 days critical', () => {
    expect(certificateFinding(new Date(now + 3 * day), now)).toMatchObject({ severity: 'critical' });
    expect(certificateFinding(new Date(now - day), now)).toMatchObject({ severity: 'critical' });
  });

  it('marks certificates inside 30 days warning and healthy ones clear', () => {
    expect(certificateFinding(new Date(now + 20 * day), now)).toMatchObject({ severity: 'warning' });
    expect(certificateFinding(new Date(now + 60 * day), now)).toBeNull();
    expect(certificateFinding('bad-date', now)).toBeNull();
  });
});
