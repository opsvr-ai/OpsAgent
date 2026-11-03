ALTER TABLE scenarios ADD COLUMN schedule_interval_minutes integer;
ALTER TABLE scenarios ADD COLUMN schedule_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE scenarios ADD COLUMN last_run_at timestamptz;
