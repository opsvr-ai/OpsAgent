CREATE TABLE IF NOT EXISTS agent_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('service', 'process', 'port', 'ops_tool')),
  name text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  important boolean NOT NULL DEFAULT false,
  monitored boolean NOT NULL DEFAULT false,
  app_system_id uuid REFERENCES app_systems(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, kind, name)
);

ALTER TABLE agent_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_inventory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_inventory_tenant ON agent_inventory;
CREATE POLICY agent_inventory_tenant ON agent_inventory
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
