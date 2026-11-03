CREATE TABLE studio_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  goal text NOT NULL,
  platform text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  bundle jsonb,
  test_report jsonb,
  reviewer_id uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE studio_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY studio_sessions_tenant_isolation ON studio_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
