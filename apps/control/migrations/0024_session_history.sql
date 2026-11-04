ALTER TABLE runtime_sessions ADD COLUMN IF NOT EXISTS dsh_session_id text;

CREATE TABLE IF NOT EXISTS session_transcripts (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'event')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_transcripts_session_idx
  ON session_transcripts(session_id, created_at, id);

ALTER TABLE session_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_transcripts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_transcripts_tenant_isolation ON session_transcripts;
CREATE POLICY session_transcripts_tenant_isolation ON session_transcripts
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
