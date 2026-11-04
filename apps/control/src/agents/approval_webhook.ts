import { createHmac } from 'node:crypto';

export type ApprovalNotificationType =
  | 'approval_requested'
  | 'approval_approved'
  | 'approval_denied'
  | 'approval_canceled'
  | 'approval_expired'
  | 'approval_expiring';

export interface ApprovalNotification {
  readonly type: ApprovalNotificationType;
  readonly tenantId: string;
  readonly approvalId: string;
  readonly agentId?: string;
  readonly hostname?: string;
  readonly action?: string;
  readonly service?: string | null;
  readonly instruction?: string;
}

/** Fire-and-forget webhook with bounded retries. */
export function notifyApprovalWebhook(event: ApprovalNotification): void {
  const url = process.env.OPSAGENT_APPROVAL_WEBHOOK_URL;
  if (!url) return;
  const body = JSON.stringify({ ...event, at: new Date().toISOString() });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = process.env.OPSAGENT_APPROVAL_WEBHOOK_SECRET;
  if (secret) {
    headers['x-opsagent-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }
  const configured = Number.parseInt(process.env.OPSAGENT_APPROVAL_WEBHOOK_RETRIES ?? '3', 10);
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
        console.error(`approval webhook failed status=${response.status} attempt=${attempt}`);
      } catch (error) {
        console.error(`approval webhook failed attempt=${attempt}`, error);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  })();
}
