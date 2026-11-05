CREATE TABLE IF NOT EXISTS fault_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_system_id uuid REFERENCES app_systems(id) ON DELETE SET NULL,
  app_system_name text NOT NULL DEFAULT '',
  title text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  trigger_event_id uuid REFERENCES agent_events(id) ON DELETE SET NULL,
  trigger_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  summary text NOT NULL DEFAULT '',
  root_cause text NOT NULL DEFAULT '',
  confidence numeric NOT NULL DEFAULT 0,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE fault_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE fault_analyses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fault_analyses_tenant ON fault_analyses;
CREATE POLICY fault_analyses_tenant ON fault_analyses
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TABLE IF NOT EXISTS fault_analysis_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES fault_analyses(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'completed',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fault_analysis_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE fault_analysis_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fault_analysis_steps_tenant ON fault_analysis_steps;
CREATE POLICY fault_analysis_steps_tenant ON fault_analysis_steps
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
