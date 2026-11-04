CREATE TABLE IF NOT EXISTS agent_instruction_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  instruction text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE agent_instruction_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_instruction_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_instruction_templates_tenant ON agent_instruction_templates;
CREATE POLICY agent_instruction_templates_tenant ON agent_instruction_templates
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
