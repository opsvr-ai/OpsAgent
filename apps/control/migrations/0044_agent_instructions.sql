ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users(id);
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS instruction text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS instruction_intent jsonb;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS agent_commands_client_request_idx
  ON agent_commands(tenant_id, agent_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
