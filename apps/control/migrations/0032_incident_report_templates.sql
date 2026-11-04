CREATE TABLE IF NOT EXISTS incident_report_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'default',
  body text NOT NULL,
  is_default boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE incident_report_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_report_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_report_templates_tenant ON incident_report_templates;
CREATE POLICY incident_report_templates_tenant ON incident_report_templates
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
