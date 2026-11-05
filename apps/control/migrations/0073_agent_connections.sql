CREATE TABLE IF NOT EXISTS agent_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  local_address text NOT NULL DEFAULT '',
  local_port integer NOT NULL DEFAULT 0,
  remote_address text NOT NULL DEFAULT '',
  remote_port integer NOT NULL DEFAULT 0,
  process text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'ESTAB',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, local_address, local_port, remote_address, remote_port, process)
);

ALTER TABLE agent_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_connections_tenant ON agent_connections;
CREATE POLICY agent_connections_tenant ON agent_connections
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
