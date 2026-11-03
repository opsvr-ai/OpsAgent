CREATE TABLE long_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  run_id uuid REFERENCES scenario_runs(id) ON DELETE SET NULL,
  error text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE long_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE long_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY long_tasks_tenant_isolation ON long_tasks
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
