CREATE TABLE model_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  api_key_encrypted text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE model_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_providers FORCE ROW LEVEL SECURITY;

CREATE POLICY model_providers_tenant_isolation ON model_providers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
