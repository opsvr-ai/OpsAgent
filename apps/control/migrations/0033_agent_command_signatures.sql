ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS signed_payload text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS signature text;
