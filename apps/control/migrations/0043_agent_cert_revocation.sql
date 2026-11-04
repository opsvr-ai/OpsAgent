ALTER TABLE agents ADD COLUMN IF NOT EXISTS certificate_revoked_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS certificate_revoked_reason text;
