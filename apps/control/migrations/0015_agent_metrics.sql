ALTER TABLE agents ADD COLUMN metrics jsonb NOT NULL DEFAULT '{}'::jsonb;
