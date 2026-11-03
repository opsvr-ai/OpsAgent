CREATE TABLE data_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  tool text NOT NULL,
  cache_key text NOT NULL,
  payload jsonb NOT NULL,
  bytes integer NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX data_snapshots_tenant_created_idx ON data_snapshots (tenant_id, created_at DESC);

ALTER TABLE data_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY data_snapshots_tenant_isolation ON data_snapshots
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
