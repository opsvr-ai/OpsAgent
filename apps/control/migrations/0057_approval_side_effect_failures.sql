CREATE TABLE IF NOT EXISTS approval_side_effect_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  approval_id uuid REFERENCES agent_instruction_approvals(id) ON DELETE SET NULL,
  effect text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS approval_side_effect_failures_open_idx
  ON approval_side_effect_failures(tenant_id, resolved_at, created_at DESC);

ALTER TABLE approval_side_effect_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_side_effect_failures FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_side_effect_failures_tenant ON approval_side_effect_failures;
CREATE POLICY approval_side_effect_failures_tenant ON approval_side_effect_failures
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
