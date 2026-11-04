ALTER TABLE incidents ADD COLUMN IF NOT EXISTS due_at timestamptz;

UPDATE incidents
SET due_at = created_at + CASE severity
  WHEN 'P1' THEN interval '30 minutes'
  WHEN 'P2' THEN interval '2 hours'
  WHEN 'P3' THEN interval '8 hours'
  ELSE interval '24 hours'
END
WHERE due_at IS NULL;

CREATE OR REPLACE FUNCTION set_incident_due_at() RETURNS trigger AS $$
BEGIN
  IF NEW.due_at IS NULL OR (TG_OP = 'UPDATE' AND NEW.severity IS DISTINCT FROM OLD.severity) THEN
    NEW.due_at := now() + CASE NEW.severity
      WHEN 'P1' THEN interval '30 minutes'
      WHEN 'P2' THEN interval '2 hours'
      WHEN 'P3' THEN interval '8 hours'
      ELSE interval '24 hours'
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incidents_due_at ON incidents;
CREATE TRIGGER incidents_due_at
  BEFORE INSERT OR UPDATE OF severity ON incidents
  FOR EACH ROW EXECUTE FUNCTION set_incident_due_at();
