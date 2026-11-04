export interface CertificateFinding {
  readonly severity: 'warning' | 'critical';
  readonly title: string;
  readonly detail: string;
}

export function certificateFinding(
  expiresAt: string | Date,
  now: number = Date.now(),
): CertificateFinding | null {
  const expires = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return null;
  const remainingMs = expires - now;
  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  if (remainingMs < 7 * 24 * 60 * 60 * 1000) {
    return {
      severity: 'critical',
      title: 'Agent 客户端证书即将过期',
      detail: remainingMs <= 0 ? '证书已过期' : `证书剩余 ${days} 天`,
    };
  }
  if (remainingMs < 30 * 24 * 60 * 60 * 1000) {
    return {
      severity: 'warning',
      title: 'Agent 客户端证书即将过期',
      detail: `证书剩余 ${days} 天`,
    };
  }
  return null;
}
