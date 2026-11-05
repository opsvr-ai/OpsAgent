CREATE TABLE IF NOT EXISTS agent_control_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instruction text NOT NULL,
  target_mode text NOT NULL CHECK (target_mode IN ('agent', 'app_system', 'all_online')),
  target_id uuid,
  target_name text,
  status text NOT NULL DEFAULT 'pending',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE agent_control_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_control_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_control_tasks_tenant ON agent_control_tasks;
CREATE POLICY agent_control_tasks_tenant ON agent_control_tasks
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TABLE IF NOT EXISTS agent_control_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES agent_control_tasks(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  command_id uuid,
  status text NOT NULL DEFAULT 'pending',
  answer text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE agent_control_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_control_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_control_runs_tenant ON agent_control_runs;
CREATE POLICY agent_control_runs_tenant ON agent_control_runs
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
