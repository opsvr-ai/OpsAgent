ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS app_system_id uuid REFERENCES app_systems(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trigger_event_id uuid REFERENCES agent_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS root_cause text;

CREATE TABLE IF NOT EXISTS incident_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  source text NOT NULL,
  summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  statement text NOT NULL,
  confidence integer NOT NULL DEFAULT 50,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  title text NOT NULL,
  assignee text NOT NULL,
  status text NOT NULL DEFAULT 'todo',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incident_evidence_incident_idx ON incident_evidence(incident_id, created_at);
CREATE INDEX IF NOT EXISTS incident_hypotheses_incident_idx ON incident_hypotheses(incident_id, created_at);
CREATE INDEX IF NOT EXISTS incident_tickets_incident_idx ON incident_tickets(incident_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_trigger_event_unique ON incidents(trigger_event_id) WHERE trigger_event_id IS NOT NULL;

ALTER TABLE incident_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE incident_hypotheses ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_hypotheses FORCE ROW LEVEL SECURITY;
ALTER TABLE incident_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_tickets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_evidence_tenant ON incident_evidence;
CREATE POLICY incident_evidence_tenant ON incident_evidence
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

DROP POLICY IF EXISTS incident_hypotheses_tenant ON incident_hypotheses;
CREATE POLICY incident_hypotheses_tenant ON incident_hypotheses
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

DROP POLICY IF EXISTS incident_tickets_tenant ON incident_tickets;
CREATE POLICY incident_tickets_tenant ON incident_tickets
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
