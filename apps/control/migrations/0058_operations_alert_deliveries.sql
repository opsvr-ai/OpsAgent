CREATE TABLE IF NOT EXISTS operations_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('pending', 'delivered', 'failed'))
);

CREATE INDEX IF NOT EXISTS operations_alert_deliveries_status_idx
  ON operations_alert_deliveries(tenant_id, status, created_at DESC);

ALTER TABLE operations_alert_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_alert_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operations_alert_deliveries_tenant ON operations_alert_deliveries;
CREATE POLICY operations_alert_deliveries_tenant ON operations_alert_deliveries
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
