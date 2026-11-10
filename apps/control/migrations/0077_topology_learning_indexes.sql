-- 0076 的补充索引：窗口样本按接收时间清理、拓扑图按版本取最新、自动学习策略查到期。
-- 迁移会在每次控制面启动时重放，必须保持幂等（只新增索引，不改 0076 已有结构）。

-- 清理过期窗口样本：purgeOlderThan 按 received_at 删除。
CREATE INDEX IF NOT EXISTS agent_connection_edges_received_idx
  ON agent_connection_edges (received_at);

-- 取最新拓扑图 / 计算新版本号：按 scope + version 排序。
CREATE INDEX IF NOT EXISTS topology_graphs_scope_version_idx
  ON topology_graphs (tenant_id, scope_kind, app_system_id, version DESC);

-- 自动学习调度器扫描到期策略。
CREATE INDEX IF NOT EXISTS topology_learning_policies_due_idx
  ON topology_learning_policies (next_run_at)
  WHERE enabled;
