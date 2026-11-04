ALTER TABLE approval_webhook_deliveries
  ADD COLUMN IF NOT EXISTS auto_replay_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_auto_replay_at timestamptz;
