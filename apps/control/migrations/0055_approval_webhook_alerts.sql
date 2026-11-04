CREATE TABLE IF NOT EXISTS approval_webhook_alert_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_alert_at timestamptz NOT NULL DEFAULT now(),
  failed_count integer NOT NULL DEFAULT 0
);

ALTER TABLE approval_webhook_alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_webhook_alert_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_webhook_alert_state_tenant ON approval_webhook_alert_state;
CREATE POLICY approval_webhook_alert_state_tenant ON approval_webhook_alert_state
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
