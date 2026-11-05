CREATE TABLE IF NOT EXISTS agent_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'custom' CHECK (source IN ('builtin', 'custom')),
  checksum text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_skills_tenant ON agent_skills;
CREATE POLICY agent_skills_tenant ON agent_skills
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TABLE IF NOT EXISTS agent_skill_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('all', 'app_system', 'agent')),
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, skill_id, scope, target_id)
);

ALTER TABLE agent_skill_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skill_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_skill_assignments_tenant ON agent_skill_assignments;
CREATE POLICY agent_skill_assignments_tenant ON agent_skill_assignments
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
