CREATE TABLE IF NOT EXISTS app_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  owner text,
  criticality text NOT NULL DEFAULT 'P2',
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

ALTER TABLE app_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_systems FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_systems_tenant_isolation ON app_systems;
CREATE POLICY app_systems_tenant_isolation ON app_systems
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS app_system_id uuid REFERENCES app_systems(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS system_info jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS applications jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_info jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS discovery_at timestamptz;

CREATE INDEX IF NOT EXISTS agents_tenant_app_system_idx ON agents(tenant_id, app_system_id);
CREATE INDEX IF NOT EXISTS agents_tenant_last_seen_idx ON agents(tenant_id, last_seen DESC);
