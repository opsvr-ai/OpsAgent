ALTER TABLE approval_webhook_alert_state
  ADD COLUMN IF NOT EXISTS alert_active boolean NOT NULL DEFAULT false;
