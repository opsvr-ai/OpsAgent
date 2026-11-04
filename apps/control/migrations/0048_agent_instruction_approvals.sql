CREATE TABLE IF NOT EXISTS agent_instruction_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  instruction text NOT NULL,
  action text NOT NULL,
  service text,
  risk text NOT NULL DEFAULT 'R2',
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decision_reason text,
  command_id uuid REFERENCES agent_commands(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (status IN ('pending', 'approved', 'denied', 'canceled'))
);

CREATE INDEX IF NOT EXISTS agent_instruction_approvals_pending_idx
  ON agent_instruction_approvals(tenant_id, status, created_at DESC);

ALTER TABLE agent_instruction_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_instruction_approvals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_instruction_approvals_tenant ON agent_instruction_approvals;
CREATE POLICY agent_instruction_approvals_tenant ON agent_instruction_approvals
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
