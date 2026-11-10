-- 访问拓扑 V2：默认只把归属应用系统的主机纳入拓扑；可显式开启包含未归属主机。
-- 迁移每次启动重放，保持幂等。

ALTER TABLE topology_learning_sessions
  ADD COLUMN IF NOT EXISTS include_unassigned boolean NOT NULL DEFAULT false;

ALTER TABLE topology_learning_policies
  ADD COLUMN IF NOT EXISTS include_unassigned boolean NOT NULL DEFAULT false;
