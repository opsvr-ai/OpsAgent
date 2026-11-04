ALTER TABLE releases ADD COLUMN IF NOT EXISTS deploy_command text;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS rollback_command text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS execution jsonb;
