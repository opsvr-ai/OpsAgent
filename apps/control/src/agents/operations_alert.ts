import { createHmac } from 'node:crypto';

export interface OperationsAlert {
  readonly tenantId: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'warning' | 'info';
}

/** Sends an operational alert to a separate webhook (independent of approval delivery). */
export function notifyOperationsAlert(alert: OperationsAlert): void {
  const url = process.env.OPSAGENT_OPERATIONS_ALERT_URL;
  if (!url) return;
  const body = JSON.stringify({ ...alert, at: new Date().toISOString() });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = process.env.OPSAGENT_OPERATIONS_ALERT_SECRET;
  if (secret) {
    headers['x-opsagent-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }
  void fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(3000),
  }).catch((error) => {
    console.error('operations alert webhook failed', error);
  });
}
