-- 访问拓扑自动学习：建连边窗口样本、学习会话、拓扑图、自动学习策略。
-- 迁移会在每次控制面启动时重放，必须保持幂等。

-- Agent 心跳上报的建连边窗口样本（默认 10s 一个窗口，字段与连接契约一致）。
CREATE TABLE IF NOT EXISTS agent_connection_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'procfs',
  direction text NOT NULL DEFAULT 'out',
  process text NOT NULL DEFAULT '',
  pid integer NOT NULL DEFAULT 0,
  service text NOT NULL DEFAULT '',
  command text NOT NULL DEFAULT '',
  local_address text NOT NULL DEFAULT '',
  local_port integer NOT NULL DEFAULT 0,
  peer_address text NOT NULL DEFAULT '',
  peer_port integer NOT NULL DEFAULT 0,
  protocol text NOT NULL DEFAULT 'tcp',
  opened integer NOT NULL DEFAULT 0,
  closed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 0,
  container text NOT NULL DEFAULT '',
  baseline boolean NOT NULL DEFAULT false,
  first_seen timestamptz,
  last_seen timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, window_start, direction, process, pid,
          local_address, local_port, peer_address, peer_port)
);

CREATE INDEX IF NOT EXISTS agent_connection_edges_window_idx
  ON agent_connection_edges (tenant_id, window_start);
CREATE INDEX IF NOT EXISTS agent_connection_edges_agent_window_idx
  ON agent_connection_edges (tenant_id, agent_id, window_start);
CREATE INDEX IF NOT EXISTS agent_connection_edges_peer_idx
  ON agent_connection_edges (tenant_id, peer_address, peer_port);

ALTER TABLE agent_connection_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_connection_edges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_connection_edges_tenant ON agent_connection_edges;
CREATE POLICY agent_connection_edges_tenant ON agent_connection_edges
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

-- 固定时间窗学习会话：collecting → aggregating → analyzing → ready/failed/cancelled。
CREATE TABLE IF NOT EXISTS topology_learning_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_kind text NOT NULL DEFAULT 'tenant' CHECK (scope_kind IN ('tenant', 'app-system')),
  app_system_id uuid REFERENCES app_systems(id) ON DELETE SET NULL,
  window_seconds integer NOT NULL DEFAULT 300,
  status text NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'aggregating', 'analyzing', 'ready', 'failed', 'cancelled')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  completed_at timestamptz,
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  fallback boolean NOT NULL DEFAULT false,
  graph_id uuid,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS topology_learning_sessions_tenant_idx
  ON topology_learning_sessions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS topology_learning_sessions_status_idx
  ON topology_learning_sessions (tenant_id, status, ends_at);

ALTER TABLE topology_learning_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_learning_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS topology_learning_sessions_tenant ON topology_learning_sessions;
CREATE POLICY topology_learning_sessions_tenant ON topology_learning_sessions
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

-- 学习生成的拓扑图快照（不可变版本，便于对比与回溯）。
CREATE TABLE IF NOT EXISTS topology_graphs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES topology_learning_sessions(id) ON DELETE CASCADE,
  scope_kind text NOT NULL DEFAULT 'tenant' CHECK (scope_kind IN ('tenant', 'app-system')),
  app_system_id uuid REFERENCES app_systems(id) ON DELETE SET NULL,
  mode text NOT NULL DEFAULT 'host' CHECK (mode IN ('host', 'app-system')),
  version integer NOT NULL DEFAULT 1,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  window_seconds integer NOT NULL DEFAULT 300,
  nodes jsonb NOT NULL DEFAULT '[]'::jsonb,
  edges jsonb NOT NULL DEFAULT '[]'::jsonb,
  systems jsonb NOT NULL DEFAULT '[]'::jsonb,
  analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  fallback boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS topology_graphs_tenant_idx
  ON topology_graphs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS topology_graphs_app_system_idx
  ON topology_graphs (tenant_id, app_system_id, created_at DESC);
CREATE INDEX IF NOT EXISTS topology_graphs_session_idx
  ON topology_graphs (session_id);

ALTER TABLE topology_graphs ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_graphs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS topology_graphs_tenant ON topology_graphs;
CREATE POLICY topology_graphs_tenant ON topology_graphs
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

-- 自动学习策略：控制面调度器按 next_run_at 触发学习会话。
CREATE TABLE IF NOT EXISTS topology_learning_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  interval_seconds integer NOT NULL DEFAULT 21600,
  window_seconds integer NOT NULL DEFAULT 300,
  scope_kind text NOT NULL DEFAULT 'tenant' CHECK (scope_kind IN ('tenant', 'app-system')),
  app_system_id uuid REFERENCES app_systems(id) ON DELETE SET NULL,
  last_run_at timestamptz,
  next_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE topology_learning_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_learning_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS topology_learning_policies_tenant ON topology_learning_policies;
CREATE POLICY topology_learning_policies_tenant ON topology_learning_policies
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
