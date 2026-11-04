ALTER TABLE agent_commands
  ADD COLUMN IF NOT EXISTS incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS incident_linked_at timestamptz;
