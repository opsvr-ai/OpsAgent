ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS nonce uuid;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS key_id text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS expires_at timestamptz;
