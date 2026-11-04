CREATE TABLE IF NOT EXISTS traffic_canary_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  host text NOT NULL,
  stable_upstream text NOT NULL,
  canary_upstream text NOT NULL,
  canary_weight integer NOT NULL DEFAULT 10 CHECK (canary_weight >= 0 AND canary_weight <= 100),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, deployment_id)
);

ALTER TABLE traffic_canary_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE traffic_canary_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS traffic_canary_policies_tenant ON traffic_canary_policies;
CREATE POLICY traffic_canary_policies_tenant ON traffic_canary_policies
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
