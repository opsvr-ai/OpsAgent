CREATE TABLE IF NOT EXISTS approval_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  approval_id text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('pending', 'delivered', 'failed'))
);

CREATE INDEX IF NOT EXISTS approval_webhook_deliveries_status_idx
  ON approval_webhook_deliveries(tenant_id, status, created_at DESC);

ALTER TABLE approval_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_webhook_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_webhook_deliveries_tenant ON approval_webhook_deliveries;
CREATE POLICY approval_webhook_deliveries_tenant ON approval_webhook_deliveries
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
