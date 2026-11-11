-- Agent 七层旁路解析（明文 HTTP/1、HTTP/2、gRPC）的请求级窗口样本。
-- 迁移每次启动重放，保持幂等；保留 7 天由控制面低频清理。

CREATE TABLE IF NOT EXISTS agent_http_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  direction text NOT NULL DEFAULT 'out',
  protocol text NOT NULL DEFAULT 'http1',
  method text NOT NULL DEFAULT '',
  local_address text NOT NULL DEFAULT '',
  local_port integer NOT NULL DEFAULT 0,
  peer_address text NOT NULL DEFAULT '',
  peer_port integer NOT NULL DEFAULT 0,
  service text NOT NULL DEFAULT '',
  requests integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  first_seen timestamptz,
  last_seen timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, window_start, window_end, direction, protocol,
          method, local_address, local_port, peer_address, peer_port)
);

CREATE INDEX IF NOT EXISTS agent_http_requests_window_idx
  ON agent_http_requests (tenant_id, window_start DESC);
CREATE INDEX IF NOT EXISTS agent_http_requests_agent_window_idx
  ON agent_http_requests (tenant_id, agent_id, window_start);
CREATE INDEX IF NOT EXISTS agent_http_requests_received_idx
  ON agent_http_requests (received_at);

ALTER TABLE agent_http_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_http_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_http_requests_tenant ON agent_http_requests;
CREATE POLICY agent_http_requests_tenant ON agent_http_requests
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);
