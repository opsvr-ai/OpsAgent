CREATE TABLE scenario_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reviewer_id uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

ALTER TABLE scenario_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_shares FORCE ROW LEVEL SECURITY;

CREATE POLICY scenario_shares_tenant_isolation ON scenario_shares
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
