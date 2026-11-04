export interface ResourceFinding {
  readonly fingerprint: string;
  readonly severity: 'warning' | 'critical';
  readonly title: string;
  readonly detail: string;
  readonly metric: Record<string, unknown>;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function resourceFindings(metrics: Readonly<Record<string, unknown>> | null): ResourceFinding[] {
  if (!metrics) return [];
  const findings: ResourceFinding[] = [];
  const memory = number(metrics.memLoadPct);
  if (memory !== null && memory >= 90) {
    findings.push({
      fingerprint: 'resource.memory',
      severity: memory >= 97 ? 'critical' : 'warning',
      title: 'Agent 内存使用率过高',
      detail: `内存使用率 ${memory.toFixed(1)}%，超过 90% 阈值`,
      metric: { memLoadPct: memory },
    });
  }
  const total = number(metrics.diskTotalGB);
  const free = number(metrics.diskFreeGB);
  if (total !== null && free !== null && total > 0) {
    const usedPct = ((total - free) / total) * 100;
    if (usedPct >= 90) {
      findings.push({
        fingerprint: 'resource.disk',
        severity: usedPct >= 97 ? 'critical' : 'warning',
        title: 'Agent 磁盘使用率过高',
        detail: `磁盘使用率 ${usedPct.toFixed(1)}%，剩余 ${free.toFixed(1)} GB`,
        metric: { diskTotalGB: total, diskFreeGB: free, usedPct: Math.round(usedPct * 10) / 10 },
      });
    }
  }
  return findings;
}
