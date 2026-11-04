import { describe, expect, it } from 'vitest';
import { resourceFindings } from '../src/agents/resource-findings.js';

describe('resource findings', () => {
  it('flags high memory and disk pressure', () => {
    const findings = resourceFindings({ memLoadPct: 98.2, diskTotalGB: 100, diskFreeGB: 2 });
    expect(findings).toEqual([
      expect.objectContaining({ fingerprint: 'resource.memory', severity: 'critical' }),
      expect.objectContaining({ fingerprint: 'resource.disk', severity: 'critical' }),
    ]);
  });

  it('ignores healthy or incomplete metrics', () => {
    expect(resourceFindings({ memLoadPct: 40, diskTotalGB: 100, diskFreeGB: 60 })).toEqual([]);
    expect(resourceFindings({ memLoadPct: 95 })).toEqual([
      expect.objectContaining({ fingerprint: 'resource.memory', severity: 'warning' }),
    ]);
    expect(resourceFindings(null)).toEqual([]);
  });
});
