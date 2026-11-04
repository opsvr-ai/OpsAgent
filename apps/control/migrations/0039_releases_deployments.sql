CREATE TABLE IF NOT EXISTS releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_system_id uuid REFERENCES app_systems(id) ON DELETE SET NULL,
  version text NOT NULL,
  artifact_url text NOT NULL,
  sha256 text NOT NULL,
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'verified',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app_system_id, version)
);

CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'production',
  strategy text NOT NULL DEFAULT 'rolling',
  canary_percent integer,
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS deployments_tenant_created_idx ON deployments(tenant_id, created_at DESC);

ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE releases FORCE ROW LEVEL SECURITY;
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS releases_tenant ON releases;
CREATE POLICY releases_tenant ON releases
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

DROP POLICY IF EXISTS deployments_tenant ON deployments;
CREATE POLICY deployments_tenant ON deployments
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
