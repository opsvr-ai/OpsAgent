CREATE TABLE connector_credentials (
  connector_id uuid PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  encrypted_payload text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE connector_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_credentials_tenant_isolation ON connector_credentials
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
