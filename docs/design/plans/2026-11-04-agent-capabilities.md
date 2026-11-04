# Agent 客户端能力增强：运行时长与主机概览

## 问题

原 CLI 对“系统运行多久了”回答：

```text
没有采集“系统运行时长”这一项
```

原因是：

- 心跳 metrics 只有内存/磁盘
- inspect 没有 uptime 探测项
- 直接执行 `uptime` 在受限环境会被 approval 拒绝
- CPU 输出较长，截断后看不到启动时间

## 改造

### 1. 心跳指标

新增：

```text
hostUptimeSec
bootTime
load1 / load5 / load15
processCount
```

Linux 来源：

```text
/proc/uptime
/proc/loadavg
/proc/[0-9]+
```

Windows 来源：

```text
GetTickCount64
```

不再依赖 `uptime` 命令，避免 approval 拒绝。

### 2. inspect 核心信息

对于“系统运行多久了”等问题，返回：

```text
- 系统运行时长：2 小时 25 分钟（启动于 2026-11-04T11:19:21Z）
- 进程数：2
- 1 分钟负载：0.13
```

同时保留：

```text
主机名 / OS / 内核 / CPU 核数 / 内存 / 磁盘
```

### 3. 支持的追问

```text
系统运行多久了
开机时间
负载
有多少进程
磁盘分区
内存
CPU
服务
端口
进程
日志
网络
容器
Agent 部署路径
```

### 4. 真机验证

```text
POST /api/agents/:id/commands
type=inspect
question=系统运行多久了
```

结果：

```text
status completed
- 系统运行时长：2 小时 25 分钟（启动于 2026-11-04T11:19:21Z）
- 进程数：2
- 1 分钟负载：0.13
```

### 5. 测试

`go test ./...` 覆盖：

- 运行时长问题必须返回“系统运行时长”
- 必须包含启动时间
- 原有磁盘问题仍正常回答

## 后续

- 进程数在容器内只统计容器 PID namespace，后续可增加宿主 PID 模式
- Windows 负载平均值不可用，返回 0/省略
- 启动时间来源为当前时间减 uptime，NTP 校时后可能略有偏差
- 可继续增加 top CPU / top 内存进程、磁盘 inode、服务失败单元
