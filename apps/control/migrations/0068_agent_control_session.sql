ALTER TABLE agent_control_tasks
  ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS agent_control_tasks_session_idx
  ON agent_control_tasks (tenant_id, session_id, created_at DESC);
