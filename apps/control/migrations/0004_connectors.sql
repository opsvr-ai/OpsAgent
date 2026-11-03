CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_type text NOT NULL,
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_ref text,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors FORCE ROW LEVEL SECURITY;

CREATE POLICY connectors_tenant_isolation ON connectors
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
