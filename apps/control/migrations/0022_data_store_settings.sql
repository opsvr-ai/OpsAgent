CREATE TABLE data_store_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  priority text NOT NULL DEFAULT 'local-first',
  sync_interval text NOT NULL DEFAULT '5m',
  full_sync_at text NOT NULL DEFAULT '02:00',
  freshness_sec integer NOT NULL DEFAULT 600,
  retention_days integer NOT NULL DEFAULT 30,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE data_store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_store_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY data_store_settings_tenant_isolation ON data_store_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
