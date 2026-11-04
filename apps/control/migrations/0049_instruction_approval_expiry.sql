ALTER TABLE agent_instruction_approvals
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours';

ALTER TABLE agent_instruction_approvals
  DROP CONSTRAINT IF EXISTS agent_instruction_approvals_status_check;

ALTER TABLE agent_instruction_approvals
  ADD CONSTRAINT agent_instruction_approvals_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'canceled', 'expired'));

CREATE INDEX IF NOT EXISTS agent_instruction_approvals_expiry_idx
  ON agent_instruction_approvals(tenant_id, status, expires_at);
