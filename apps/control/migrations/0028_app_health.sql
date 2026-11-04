ALTER TABLE agent_events
  ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS app_system_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_system_id uuid NOT NULL REFERENCES app_systems(id) ON DELETE CASCADE,
  trigger_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  trigger_event_id uuid REFERENCES agent_events(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'completed',
  summary text NOT NULL,
  root_cause text NOT NULL,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS app_health_system_created_idx
  ON app_system_health_checks(app_system_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_health_tenant_created_idx
  ON app_system_health_checks(tenant_id, created_at DESC);

ALTER TABLE app_system_health_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_system_health_checks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_health_tenant_isolation ON app_system_health_checks;
CREATE POLICY app_health_tenant_isolation ON app_system_health_checks
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
