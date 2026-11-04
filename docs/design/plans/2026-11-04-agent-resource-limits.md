# Agent 资源限额切片

## 状态

已完成 systemd cgroup 与容器资源限额。

## systemd

安装脚本生成：

```ini
MemoryMax=512M
CPUQuota=50%
IOReadBandwidthMax=/ 200M
IOWriteBandwidthMax=/ 200M
TasksMax=256
```

可通过环境变量覆盖：

```text
OPSAGENT_AGENT_MEMORY_MAX=1G
OPSAGENT_AGENT_CPU_QUOTA=80%
OPSAGENT_AGENT_IO_READ_MAX=300M
OPSAGENT_AGENT_IO_WRITE_MAX=300M
```

非法值自动回退默认值。

## 容器

`compose.agent.yaml` 支持：

```text
OPSAGENT_AGENT_MEMORY_LIMIT=1g
OPSAGENT_AGENT_CPUS=1.0
```

映射到 Docker `mem_limit` / `cpus`。

## 资源告警

`AgentResourceMonitor` 每 60 秒检查在线 Agent：

```text
内存使用率 ≥ 90% → warning
内存使用率 ≥ 97% → critical
磁盘使用率 ≥ 90% → warning
磁盘使用率 ≥ 97% → critical
```

事件指纹：

```text
resource.memory
resource.disk
```

恢复后自动 resolve，并写入消息中心。

## 验证

- 安装脚本测试断言 `MemoryMax=512M`、`CPUQuota=50%`、`IOReadBandwidthMax=/ 200M`、`IOWriteBandwidthMax=/ 200M`、`TasksMax=256`
- `docker compose ... config` 输出 `mem_limit` 与 `cpus`
- `pnpm build`、`pnpm test` 通过
- `resource-findings` 单测覆盖阈值与恢复

## 剩余

- Windows Job Object 内存限制
