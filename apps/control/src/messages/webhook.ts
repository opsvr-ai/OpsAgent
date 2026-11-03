export interface WebhookPayload {
  readonly title: string;
  readonly body: string;
  readonly severity: string;
}

export async function sendWebhook(
  payload: WebhookPayload,
  url = process.env.OPSAGENT_WEBHOOK_URL,
): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Notification delivery must never fail the control-plane operation.
  }
}
