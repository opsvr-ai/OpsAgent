-- 自然语言拓扑微调历史：只影响当前视图（隐藏/显示/改名/打标签等），不修改原始学习图。
-- 迁移每次启动重放，保持幂等。

CREATE TABLE IF NOT EXISTS topology_view_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  graph_id uuid NOT NULL REFERENCES topology_graphs(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  instruction text NOT NULL,
  reply text NOT NULL DEFAULT '',
  operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL DEFAULT '',
  fallback boolean NOT NULL DEFAULT false,
  warning text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS topology_view_adjustments_graph_idx
  ON topology_view_adjustments (tenant_id, graph_id, created_at DESC);

ALTER TABLE topology_view_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_view_adjustments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS topology_view_adjustments_tenant ON topology_view_adjustments;
CREATE POLICY topology_view_adjustments_tenant ON topology_view_adjustments
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
