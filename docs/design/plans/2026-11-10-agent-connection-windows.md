# Agent 建连边表窗口采集（connectionWindows）

> 状态：已实现（T1）。代码：`agents/opsagent-agent/conntrack_edges.go`（平台无关模型）、
> `conntrack_linux.go`（procfs 采样）、`conntrack_ebpf.go`（eBPF 合并）、
> `conntrack_other.go`（非 Linux 空实现）。契约：`packages/contracts/src/topology.ts`
> 的 `ConnectionWindowReport` / `ConnectionEdgeReport`。

## 1. 数据链路

```
/proc/net/tcp{,6} ESTABLISHED ─┐
/proc/<pid>/fd inode 归因 ─────┤ 每 5s 采样 → 10s 固定窗口聚合 ─┐
/proc/net/tcp{,6} LISTEN 表 ───┘                              ├→ 心跳 connectionWindows[]
/var/log/conn_collector/edges.json（可选 eBPF）───────────────┘
```

心跳每 10s 一次；窗口由独立 goroutine 产出，缓存 12 个窗口 / 120s，**心跳
POST 成功后清空，失败保留重发**。非 Linux 平台不采样，心跳不带该字段。

## 2. 采集口径

- 只采 ESTABLISHED；LISTEN 只用于方向判定与服务名归因，不单独上报。
- 过滤 loopback（127.0.0.0/8、::1）与两端都在本机 IP 集合内的内部流量
  （含容器 veth 场景），避免把本机自访问当成外部访问关系。
- 进程归因：ESTAB 的 socket inode ↔ `/proc/<pid>/fd`；进程信息
  （comm/cmdline/service/container）缓存 30s；`in` 方向优先用监听进程信息。
- 容器：读 `/proc/<pid>/cgroup`，命中 docker/containerd/kubepods/crio 时取
  64 位容器 ID 前 12 位短 ID；kubepods 无容器 ID 时用 `pod-<UID前12位>`。
- 方向：本机端口命中监听表 → `direction=in`（本机是服务端），否则 `out`。
- 本机 IP 集合每 30s 从 `net.Interfaces` 刷新（含 loopback）。

## 3. 边界定口径（与 Control 约定）

一条边 = **同一 (direction, pid, process, peerAddress, 服务端口) 的聚合**：

- `direction=out`：本机是客户端，`peerAddress:peerPort` 是对端服务地址，
  `localPort` 恒为 `0`（客户端临时端口不参与聚合）。
- `direction=in`：本机是服务端，`localAddress:localPort` 是本机监听地址，
  `peerPort` 恒为 `0`（客户端临时端口不参与聚合）。
- 服务端口：`out` 取 `peerPort`，`in` 取 `localPort`。
- `process`/`pid`：本机侧进程；`service`：本机侧服务名（优先监听进程名 /
  `-jar xxx.jar` 的应用名，其次进程名）；`command`：cmdline 截断 512 字符。
- 计数按连接 4 元组（direction/localAddress/localPort/peerAddress/peerPort/pid）
  去重，因此聚合边的 `opened`/`closed`/`active` 可以 > 1。

### 计数语义

| 字段 | 语义 |
|------|------|
| `opened` | 本窗口内首次出现在快照中的连接数。启动基线里的存量连接不计 opened。 |
| `closed` | 本窗口内确认消失的连接数。连接需连续缺席 2 个采样周期才计 closed（防抖）。 |
| `active` | 窗口结束时仍然存活的并发连接数。长连接跨窗口保留，每个窗口都带 active。 |
| `failed` | procfs 模式恒为 0；eBPF 模式取真实失败建连数。 |
| `baseline` | 采集器启动时已存在的长连接（连接池等）；该边在生命周期内保持 true。 |
| `firstSeen`/`lastSeen` | 该聚合边内连接的最早首次观测 / 最近一次观测（RFC3339，UTC）。 |

每个窗口的边表是**全量快照**（含仅 active 的长连接），不是增量事件流；
Control 侧跨窗口求和时请只累加 opened/closed/failed，active 取窗口末值。

## 4. eBPF 可选通道（dir=out/in 与 comm 映射）

`OPSAGENT_CONN_COLLECTOR_DIR/edges.json`（默认 `/var/log/conn_collector`）若在
60s 内更新且内容合法，则读取并合并：

- 文件里是采集器生命周期累计值：首次读取只记基线，之后按 mtime 差分出窗口
  增量；检测到计数器回退视为采集器重启，当前值即增量。
- `dir=out` → `direction=out`，`peer/port` 映射为 `peerAddress/peerPort`；
  `dir=in` → `direction=in`，`port` 映射为 `localPort`。
- `comm` 的 `container:` 前缀拆出：进程名与 `container` 字段都记去掉前缀的值。
- 命中 procfs 边（同 direction + peerAddress + 服务端口 + process）时，用
  eBPF 的 `opened/closed/failed` 覆盖 procfs 估算值；未命中的 eBPF 边追加。
- `source`：仅 procfs → `"procfs"`；eBPF 参与合并 → `"hybrid"`；只有 eBPF
  边 → `"ebpf"`。文件缺失/格式错误/过期都不影响 procfs 主流程。

## 5. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `OPSAGENT_CONN_EDGES` | `true` | `false` 整体关闭采样与上报 |
| `OPSAGENT_CONN_SAMPLE_INTERVAL_SECONDS` | `5` | 采样周期，1~60s |
| `OPSAGENT_CONN_WINDOW_SECONDS` | `10` | 聚合窗口，1~600s |
| `OPSAGENT_CONN_COLLECTOR_DIR` | `/var/log/conn_collector` | eBPF 边表目录 |

上报上限：每窗口最多 400 条边（按 `opened+active` 降序），单窗口 JSON
≤256KB；被丢弃条数记入 `stats.dropped`。`stats.scans` 为窗口内采样次数，
`stats.activeConnections` 为窗口结束时存活连接总数。

心跳 `metrics.connSampler` 提供简要观测：
`{enabled, source, sampleSeconds, windowSeconds, edgeCount, pendingWindows, lastWindowAt}`。

## 6. 已知限制

- procfs 采样是快照差分：窗口小于采样周期时 opened/closed 可能落在相邻窗口；
  极短连接（两次采样之间建立并关闭）无法观测。精确建连失败依赖 eBPF 通道。
- eBPF `edges.json` 默认 60s 更新一次，其增量集中落在读到更新的那个 10s 窗口，
  单窗口数值可能偏高；同一批连接可能已被更早窗口的 procfs 估算计过一次，
  跨窗口求和时 hybrid 模式会重复计数。需要精确建连总量时，建议缩短
  conn_collector 的 `-edges-interval`，或按 eBPF 通道口径单独统计。
- 非 root 运行时 `/proc/<pid>/fd` 可能不可读：仍上报边（pid=0/process 为空），
  但无法归因进程。
- 纯 IPv6 连接可采集；与只处理 IPv4 的 eBPF 通道合并时，纯 IPv6 边只来自 procfs。
- 心跳失败重发窗口按「agent + start + end」幂等，Control 入库需按该键去重
  （网络超时可能造成同一窗口重复投递）。

## 7. 真机联调（WSL Agent → 真实 Control）

2026-11-10 在 WSL（Ubuntu-26.04）用 Linux 版 Agent 连本机 docker compose 的
真实 Control，验证「采集 → 心跳 connectionWindows → Control 入库 → 学习会话
统计到样本」整条链路。

### 环境

- Control：`http://172.27.80.1:8080`（WSL 默认网关；`/healthz` 200）。
- 租户：`00000000-0000-4000-8000-000000000001`（demo tenant）。
- enrollment token：`opsagent-local-enroll`（compose 默认值）。
- Agent：交叉编译 `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build`，
  `OPSAGENT_HOME=/tmp/opsagent-e2e`、`OPSAGENT_AGENT_NAME=wsl-e2e-ebpf`、
  采样 2s / 窗口 5s、`OPSAGENT_AUTO_CSR` 未开启（8080 走 HTTP）。
- 造数：WSL python 持续对网关 `172.27.80.1:8080` 建 TCP 连接（保持 25s），
  同时在 WSL 监听 `18081`，由 Windows 侧反复连接（in 方向）。
  外网 `1.1.1.1:443` 在该环境不通，故外部 peer 样本只有网关地址。

### 关键命令与结果

```bash
# WSL 启动 Agent（节选）
export OPSAGENT_HOME=/tmp/opsagent-e2e
export OPSAGENT_TENANT_ID=00000000-0000-4000-8000-000000000001
export OPSAGENT_CONTROL_URL=http://172.27.80.1:8080
export OPSAGENT_AGENT_NAME=wsl-e2e-ebpf
export OPSAGENT_AGENT_ENROLLMENT_TOKEN=opsagent-local-enroll
export OPSAGENT_CONN_SAMPLE_INTERVAL_SECONDS=2
export OPSAGENT_CONN_WINDOW_SECONDS=5
./opsagent-agent-linux --service
# 日志（key 已脱敏）：
# connection window baseline: 1 established connections
# http POST .../register status=201 bytes=48538
# registered agent id=7a5e4b38-57ac-4462-b4bd-cdb9d81cef1f key=****
# http POST .../heartbeat status=200 bytes=10768   （13 次心跳全部 200）
```

```text
# 1) Control DB 注册证据
select id, hostname, status, last_seen, created_at from agents
where id='7a5e4b38-57ac-4462-b4bd-cdb9d81cef1f';
-- 7a5e4b38-... | leo | online | 2026-11-10 05:29:24+00 | 2026-11-10 05:27:24+00

# 2) 边样本入库证据（96 条样本，覆盖 05:26:19 ~ 05:29:14，opened=54、closed=35）
select agent_id, window_start, direction, process, peer_address, peer_port, opened, active
from agent_connection_edges
where agent_id='7a5e4b38-57ac-4462-b4bd-cdb9d81cef1f'
order by window_start desc limit 5;
-- 05:29:14 | out | python3        | 172.27.80.1 | 8080 | 0 | 1
-- 05:29:14 | in  | python3        | 172.27.80.1 | 0    | 0 | 1
-- 05:29:14 | out | opsagent-agent-| 172.27.80.1 | 8080 | 0 | 18
-- 05:29:09 | in  | python3        | 172.27.80.1 | 0    | 1 | 1
-- 05:29:09 | out | python3        | 172.27.80.1 | 8080 | 0 | 1

# 3) 学习会话统计到新 Agent
POST /api/topologies/learn {"windowSeconds":120}
-- id=8e5aeff3-cc2b-4c83-aaee-dfa6c2c1dc6d，status: ready
-- progress: reportingAgents=14 / expectedAgents=13，edgeSamples=874，uniqueEdges=70
-- graphId=92198e91-d255-47db-b465-508d2f7b07a9
-- stats: nodeCount=21 edgeCount=37 hostCount=14 totalConnections=28844
-- topology_graphs 节点中可查到本机节点：id=h:7a5e4b38, label=leo
```

清理：停止 Agent 后删除 `/tmp/opsagent-e2e` 状态目录与临时 Agent 日志；
Control 中的 agent/边样本/学习会话保留作为联调证据。

### 结论与注意事项

- 链路打通：真实 procfs 采集 → 心跳窗口 → `agent_connection_edges` 入库 →
  学习会话统计（reportingAgents 13→14、edgeSamples 增长）→ 拓扑图出现本机节点。
- WSL 首次启动 discovery 较慢（本次注册约 75s），期间窗口先缓存；默认 10s
  窗口下缓存 6~7 个，未触及 12 个上限。生产主机注册通常更快。
- in 方向样本来自 Windows→WSL 监听端口连接（peer 为网关地址），out 方向
  样本包含 Agent 自身访问 Control 与测试脚本访问网关：临时端口均按约定为 0。
- 未发现采集器 panic、心跳失败或 `/proc` 读取错误。

## 8. 版本与升级（0.6.3 起支持）

- **Agent 版本**：`agentVersion = "0.6.3"`（此前 0.6.2 不含建连窗口采集；平台「操作系统智能体」列表/详情会显示上报版本，可据此确认是否已升级）。
- **兼容性**：新控制面向后兼容旧 Agent——旧 Agent 不发 `connectionWindows`，心跳照常成功，只是学习窗口内没有真实边样本（图里只有节点、没有访问关系）；不会报错。
- **控制面镜像**：`docker compose build control` 会在 Go 阶段把三个平台的新 Agent 二进制编译到 `/opt/opsagent-agent-dist`，`install.sh` / `GET /api/agents/binary` 分发的就是新版；**只更新前端/不重建 control 镜像，已装 Agent 仍是旧版**。
- **已装 Agent 升级**（任选其一）：
  ```bash
  # 重跑安装命令（会从控制面拉最新二进制并重启服务）
  curl -fsSL http://<control>/api/agents/install.sh | sudo bash
  # 或手工替换并重启
  systemctl stop opsagent-agent
  install -m 0755 opsagent-agent-linux-amd64 /opt/opsagent/bin/opsagent-agent
  systemctl start opsagent-agent
  ```
  升级后 `opsagent-agent --version` 应显示 `0.6.3`；控制面下一次 10s 心跳开始收到 `connectionWindows`。
- 本地非容器开发：`pnpm agent:dist` 重新生成 `agents/opsagent-agent/dist/` 下三个二进制，再把 `OPSAGENT_AGENT_DIST_DIR` 指到该目录即可。


