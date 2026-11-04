ALTER TABLE approval_side_effect_failures
  ADD COLUMN IF NOT EXISTS auto_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_auto_retry_at timestamptz;
