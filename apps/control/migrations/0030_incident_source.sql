ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS incidents_source_ref_unique
  ON incidents(tenant_id, source, source_ref)
  WHERE source_ref IS NOT NULL;
