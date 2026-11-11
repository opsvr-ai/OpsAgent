-- 访问关系标签（跨拓扑版本复用，按 relation_key 稳定关联）
CREATE TABLE IF NOT EXISTS topology_edge_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  relation_key text NOT NULL,
  label text NOT NULL,
  category text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'user',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, relation_key, label)
);

CREATE INDEX IF NOT EXISTS topology_edge_tags_relation_idx
  ON topology_edge_tags (tenant_id, relation_key);

ALTER TABLE topology_edge_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_edge_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS topology_edge_tags_tenant ON topology_edge_tags;
CREATE POLICY topology_edge_tags_tenant ON topology_edge_tags
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
