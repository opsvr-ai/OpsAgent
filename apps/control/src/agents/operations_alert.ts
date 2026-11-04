import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';

export interface OperationsAlert {
  readonly tenantId: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'warning' | 'info';
}

/** Replays one persisted operations alert delivery. */
export function replayOperationsAlert(pool: Pool, deliveryId: string, payload: string): void {
  const url = process.env.OPSAGENT_OPERATIONS_ALERT_URL;
  if (!url) return;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = process.env.OPSAGENT_OPERATIONS_ALERT_SECRET;
  if (secret) {
    headers['x-opsagent-signature'] = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  }
  const configured = Number.parseInt(process.env.OPSAGENT_OPERATIONS_ALERT_RETRIES ?? '3', 10);
  const attempts = Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 5) : 3;
  void (async () => {
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          await pool.query(
            `UPDATE operations_alert_deliveries
             SET status = 'delivered', attempts = $1, last_error = NULL, updated_at = now()
             WHERE id = $2`,
            [attempt, deliveryId],
          );
          return;
        }
        lastError = `status_${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
    await pool.query(
      `UPDATE operations_alert_deliveries
       SET status = 'failed', attempts = $1, last_error = $2, updated_at = now()
       WHERE id = $3`,
      [attempts, lastError, deliveryId],
    ).catch(() => undefined);
  })();
}

/** Sends an operational alert to a separate webhook (independent of approval delivery). */
export function notifyOperationsAlert(alert: OperationsAlert, pool?: Pool): void {
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
    let deliveryId: string | null = null;
    if (pool) {
      try {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO operations_alert_deliveries (tenant_id, title, payload)
           VALUES ($1, $2, $3::jsonb) RETURNING id`,
          [alert.tenantId, alert.title, body],
        );
        deliveryId = inserted.rows[0]?.id ?? null;
      } catch (error) {
        console.error('operations alert delivery log failed', error);
      }
    }
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          if (pool && deliveryId) {
            await pool.query(
              `UPDATE operations_alert_deliveries
               SET status = 'delivered', attempts = $1, updated_at = now()
               WHERE id = $2`,
              [attempt, deliveryId],
            ).catch(() => undefined);
          }
          return;
        }
        lastError = `status_${response.status}`;
        console.error(`operations alert webhook failed status=${response.status} attempt=${attempt}`);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(`operations alert webhook failed attempt=${attempt}`, error);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
    if (pool && deliveryId) {
      await pool.query(
        `UPDATE operations_alert_deliveries
         SET status = 'failed', attempts = $1, last_error = $2, updated_at = now()
         WHERE id = $3`,
        [attempts, lastError, deliveryId],
      ).catch(() => undefined);
    }
  })();
}
