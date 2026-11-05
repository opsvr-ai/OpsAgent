CREATE TABLE IF NOT EXISTS agent_patrol_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  interval_seconds integer NOT NULL DEFAULT 30 CHECK (interval_seconds BETWEEN 30 AND 3600),
  disk_free_pct numeric NOT NULL DEFAULT 15 CHECK (disk_free_pct BETWEEN 1 AND 99),
  mem_load_pct numeric NOT NULL DEFAULT 85 CHECK (mem_load_pct BETWEEN 1 AND 100),
  load1 numeric NOT NULL DEFAULT 0 CHECK (load1 >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id)
);

ALTER TABLE agent_patrol_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_patrol_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_patrol_policies_tenant ON agent_patrol_policies;
CREATE POLICY agent_patrol_policies_tenant ON agent_patrol_policies
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
