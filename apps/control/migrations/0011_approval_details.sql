ALTER TABLE approvals ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;
