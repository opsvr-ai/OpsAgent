ALTER TABLE agent_instruction_approvals
  ADD COLUMN IF NOT EXISTS incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_instruction_approvals_incident_idx
  ON agent_instruction_approvals(incident_id, created_at DESC);
