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
  const configured = Number.parseInt(process.env.OPSAGENT_OPERATIONS_ALERT_RETRIES ?? '3', 10);
  const attempts = Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 5) : 3;
  void (async () => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) return;
        console.error(`operations alert webhook failed status=${response.status} attempt=${attempt}`);
      } catch (error) {
        console.error(`operations alert webhook failed attempt=${attempt}`, error);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  })();
}
