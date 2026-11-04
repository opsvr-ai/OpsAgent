# Agent 资源限额切片

## 状态

已完成 systemd cgroup 与容器资源限额。

## systemd

安装脚本生成：

```ini
MemoryMax=512M
CPUQuota=50%
TasksMax=256
```

可通过环境变量覆盖：

```text
OPSAGENT_AGENT_MEMORY_MAX=1G
OPSAGENT_AGENT_CPU_QUOTA=80%
```

非法值自动回退默认值。

## 容器

`compose.agent.yaml` 支持：

```text
OPSAGENT_AGENT_MEMORY_LIMIT=1g
OPSAGENT_AGENT_CPUS=1.0
```

映射到 Docker `mem_limit` / `cpus`。

## 验证

- 安装脚本测试断言 `MemoryMax=512M`、`CPUQuota=50%`、`TasksMax=256`
- `docker compose ... config` 输出 `mem_limit` 与 `cpus`
- `pnpm build`、`pnpm test` 通过

## 剩余

- Windows Job Object 内存限制
- cgroup v2 下的 IO 限额
- 资源超限告警接入 Commander
