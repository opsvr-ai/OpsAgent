ALTER TABLE agent_instruction_approvals
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz;

CREATE INDEX IF NOT EXISTS agent_instruction_approvals_reminder_idx
  ON agent_instruction_approvals(tenant_id, status, expires_at)
  WHERE reminded_at IS NULL;
