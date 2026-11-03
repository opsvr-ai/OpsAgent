ALTER TABLE runtime_sessions ADD COLUMN runtime_session_id text;
ALTER TABLE runtime_sessions ADD COLUMN role_view text;

CREATE UNIQUE INDEX runtime_sessions_runtime_id_idx
  ON runtime_sessions(runtime_session_id)
  WHERE runtime_session_id IS NOT NULL;

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  runtime_approval_id text NOT NULL,
  action text NOT NULL,
  risk text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id),
  reason text,
  UNIQUE (session_id, runtime_approval_id)
);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;

CREATE POLICY approvals_tenant_isolation ON approvals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
