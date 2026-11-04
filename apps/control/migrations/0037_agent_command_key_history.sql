CREATE TABLE IF NOT EXISTS agent_command_key_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  previous_key_id text,
  key_id text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_command_key_history_agent_idx
  ON agent_command_key_history(agent_id, changed_at DESC);

ALTER TABLE agent_command_key_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_command_key_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_command_key_history_tenant ON agent_command_key_history;
CREATE POLICY agent_command_key_history_tenant ON agent_command_key_history
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
