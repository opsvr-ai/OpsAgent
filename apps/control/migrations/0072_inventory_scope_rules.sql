CREATE TABLE IF NOT EXISTS agent_inventory_hides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_system_id uuid REFERENCES app_systems(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_inventory_hides_app_idx
  ON agent_inventory_hides (tenant_id, app_system_id, kind, name)
  WHERE app_system_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_inventory_hides_agent_idx
  ON agent_inventory_hides (tenant_id, agent_id, kind, name)
  WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_inventory_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_system_id uuid REFERENCES app_systems(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  target_kind text,
  important boolean,
  monitored boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_inventory_overrides_app_idx
  ON agent_inventory_overrides (tenant_id, app_system_id, kind, name)
  WHERE app_system_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_inventory_overrides_agent_idx
  ON agent_inventory_overrides (tenant_id, agent_id, kind, name)
  WHERE agent_id IS NOT NULL;

ALTER TABLE agent_inventory_hides ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_inventory_hides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_inventory_hides_tenant ON agent_inventory_hides;
CREATE POLICY agent_inventory_hides_tenant ON agent_inventory_hides
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

ALTER TABLE agent_inventory_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_inventory_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_inventory_overrides_tenant ON agent_inventory_overrides;
CREATE POLICY agent_inventory_overrides_tenant ON agent_inventory_overrides
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
