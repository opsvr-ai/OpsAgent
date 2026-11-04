CREATE TABLE IF NOT EXISTS approval_notification_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_notification_archive_tenant_idx
  ON approval_notification_archive(tenant_id, kind, archived_at DESC);

ALTER TABLE approval_notification_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_notification_archive FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_notification_archive_tenant ON approval_notification_archive;
CREATE POLICY approval_notification_archive_tenant ON approval_notification_archive
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
