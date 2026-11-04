CREATE TABLE IF NOT EXISTS incident_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  action text NOT NULL,
  risk text NOT NULL DEFAULT 'R2',
  status text NOT NULL DEFAULT 'pending',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  requested_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS incident_approvals_incident_idx
  ON incident_approvals(incident_id, created_at DESC);

ALTER TABLE incident_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_approvals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_approvals_tenant ON incident_approvals;
CREATE POLICY incident_approvals_tenant ON incident_approvals
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
