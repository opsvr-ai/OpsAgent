ALTER TABLE approval_webhook_deliveries
  ADD COLUMN IF NOT EXISTS auto_replayed_at timestamptz;
