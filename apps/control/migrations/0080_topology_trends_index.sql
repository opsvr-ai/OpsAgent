-- 访问量趋势：按租户 + 时间窗口扫描 out 方向建连样本（保留 7 天）。
-- 迁移每次启动重放，保持幂等。

CREATE INDEX IF NOT EXISTS agent_connection_edges_tenant_window_out_idx
  ON agent_connection_edges (tenant_id, window_start DESC)
  WHERE direction = 'out';
