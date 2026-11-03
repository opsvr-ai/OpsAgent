ALTER TABLE scenario_runs ADD COLUMN current_step integer NOT NULL DEFAULT 0;

CREATE TABLE scenario_run_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  tool text NOT NULL,
  risk text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id),
  reason text
);

ALTER TABLE scenario_run_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_run_approvals FORCE ROW LEVEL SECURITY;

CREATE POLICY scenario_run_approvals_tenant_isolation ON scenario_run_approvals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
