# 访问拓扑自动学习：从 eBPF 建连采集到 LLM 自动绘图

> 状态：实现中（2026-11-10）
>
> 目标：操作系统智能体参考 `ebpf-coll` 的连接采集原理，把「点状 netstat 快照」升级为「固定时间窗内的建连边表」；控制面接收窗口样本后自动聚合，交给服务端大模型分析，自动生成一张**一眼看懂业务访问关系**的拓扑图，并在 Web 端以炫酷、可交互的方式呈现；业务系统之间的访问关系同样能在图上表达。

## 1. 现状与问题

已有能力：

- Agent 每 10s 心跳（`apps/control/src/agents/routes.ts`），每 5 分钟上报一次 discovery；
- discovery 里的 `operations.connections` 由 `ss -tunap` / `netstat -tunap` 采集，是**当前时刻的 ESTABLISHED 快照**；
- 控制面 `AgentConnectionService` 每次「先删后插」写入 `agent_connections`；
- `AppSystemTopologyService` 用 `agent_connections` + `agent_inventory` 拼一张应用系统访问关系图，前端在「操作系统智能体」页内以主机卡片 + 线条展示。

问题：

1. **只有点，没有窗口**：5 分钟一次快照会漏掉短连接；无法回答「过去 5 分钟谁访问了谁、建了多少次、失败多少」。
2. **没有方向与生命周期**：`ss` 输出里的 LISTEN 判定只能粗分 inbound/outbound；没有「新建 / 关闭 / 失败」计数，也没有长连接基线。
3. **噪声多**：本机回环、同机内部流量、容器网桥流量、未纳管对端混在一起，图很乱。
4. **拓扑靠规则拼装**：没有语义（谁是网关、谁是数据库、哪条是核心链路），也没有洞察与风险提示。
5. **展示不「炫酷」**：现有面板是表格化主机卡片，看不出层次、流向和业务系统边界。

## 2. 参考 `ebpf-coll` 的实现原理

`ebpf-coll`（`conn_collector`）的做法：

| 机制 | 说明 | 本项目借鉴 |
| --- | --- | --- |
| eBPF tracepoint + kprobe | `sock:inet_sock_set_state` 拿建链/关链事件，`tcp_v4/v6_connect` 登记 client 上下文 | Agent 的可选 eBPF 数据源（读取 `edges.json`）；procfs 模式用差分近似 |
| 监听端口 → 进程表 | server 方向在软中断里 comm 不可靠，用 `/proc/net/tcp` LISTEN + inode 反查修正 | 用于方向判定与服务命名 |
| 本机 IP 集合过滤 | 两端都是本机 IP 的流量在内核侧丢弃 | 采集侧跳过 loopback/同机流量 |
| 基线快照 | 采集器启动时已存在的长连接（连接池）没有状态迁移事件 | 启动时扫一次存量 ESTABLISHED，标记 `baseline` |
| 窗口边表 `edges.json` | 按 (dir, comm, peer, port) 聚合 opened/closed/failed | **本项目窗口边表的核心形态** |
| 容器识别 | 容器网桥 IP 不能归因到宿主进程 | `/proc/<pid>/cgroup` 提取容器标识 |

本项目不是直接嵌入 eBPF（Agent 要覆盖无 BTF/无 root 的老内核与 Windows），而是**双数据源**：

- **procfs 采样（默认）**：5s 采样 `/proc/net/tcp{,6}`，对 4 元组做差分，得到窗口内 opened/closed/active；启动基线 + 监听表归因 + 本机 IP 过滤。任何 Linux 可用，零依赖。
- **eBPF 增强（可选）**：若主机部署了 `ebpf-coll` 且 `/var/log/conn_collector/edges.json` 新鲜，Agent 读取其精确的 opened/closed/failed 并合并（`source=ebpf|hybrid`）。

## 3. 总体架构

```text
┌───────────── Agent（每台主机） ─────────────┐
│ /proc/net/tcp{,6} 每 5s 采样                │
│  inode→进程 / 监听表 / 本机 IP / 容器       │
│  基线扫描 + 4 元组差分 + eBPF edges.json    │
│  → 10s 窗口边表 connectionWindows           │
└──────────────┬──────────────────────────────┘
               │ 心跳（每 10s）
               ▼
┌───────────── Control Plane ─────────────────┐
│ agent_connection_edges（窗口样本，幂等 upsert）│
│ TopologyLearningService                      │
│  固定时间窗会话（60~1800s）                  │
│  窗口结束 → 聚合为 TopologyLearningInput     │
│  TopologyAnalyzer（LLM + 启发式兜底）        │
│  topology_graphs（不可变版本）               │
│  TopologyLearningScheduler（自动学习策略）    │
└──────────────┬──────────────────────────────┘
               │ GET /api/topologies/latest
               ▼
┌───────────── Web ───────────────────────────┐
│ 分层画布：ingress → app → middleware → data │
│ 业务系统色带 / 流量流光 / 聚焦上下游        │
│ 业务系统视图：系统 A → 系统 B               │
│ LLM 分析侧栏：摘要 / 核心链路 / 风险        │
└─────────────────────────────────────────────┘
```

## 4. 数据模型

迁移：`apps/control/migrations/0076_topology_learning.sql`（幂等，启动时重放）。

- `agent_connection_edges`：Agent 上报的窗口边样本。
  唯一键 `(tenant_id, agent_id, window_start, direction, process, pid, local_address, local_port, peer_address, peer_port)`；
  字段含 `opened/closed/failed/active/baseline/container/first_seen/last_seen`。
- `topology_learning_sessions`：一次固定时间窗学习。
  状态机 `collecting → aggregating → analyzing → ready|failed|cancelled`，记录 `requested_by/trigger/progress/stats/graph_id`。
- `topology_graphs`：学习产出的不可变拓扑图版本。
  存 `nodes/edges/systems/analysis/stats`（jsonb）+ `model/prompt_version/fallback/version`。
- `topology_learning_policies`：自动学习策略（开关、周期、窗口、范围、下次运行时间）。

共享类型：`packages/contracts/src/topology.ts`（Control 与 Web 共用，字段名即 API 契约）。

## 5. Agent 上报契约（心跳新增 `connectionWindows`）

```json
{
  "connectionWindows": [
    {
      "start": "2026-11-10T04:00:00Z",
      "end": "2026-11-10T04:00:10Z",
      "source": "procfs",
      "edges": [
        {
          "direction": "out",
          "process": "java", "pid": 4123, "service": "order-api",
          "command": "/opt/order/order-api.jar",
          "localAddress": "7.24.6.18", "localPort": 41234,
          "peerAddress": "7.24.6.191", "peerPort": 3306,
          "protocol": "tcp",
          "opened": 3, "closed": 2, "failed": 0, "active": 4,
          "firstSeen": "2026-11-10T04:00:01Z", "lastSeen": "2026-11-10T04:00:09Z",
          "container": "", "baseline": false
        }
      ],
      "stats": { "scans": 2, "activeConnections": 4, "dropped": 0 }
    }
  ]
}
```

约束：单次上报 ≤ 12 个窗口、每窗口 ≤ 400 条边、序列化 ≤ 256KB；`direction=out` 表示本机进程主动访问对端，`direction=in` 表示本机监听被访问；`service` 是本机侧服务名。

## 6. 聚合规则（窗口样本 → 学习输入）

1. **按主机归并**：`agents` 取 hostname/ip/app_system/status；`agent_inventory` 取监听端口与服务名、关键进程。
2. **out 边**：源 = 本机 agent + 进程/服务；目标 = `peerAddress` 反查已纳管 agent；找到则目标服务名取目标监听端口对应的服务，找不到则归入「外部/未纳管」。
3. **in 边**：目标 = 本机监听端口；源 = `peerAddress` 反查纳管 agent（拿到源进程名），否则丢弃（避免把未纳管客户端当主机）。
4. **去重合并**：同一逻辑边 `(fromAgent, fromService, toAgent|peerIp, toPort)` 合并计数；同时观测到 out 与 in 时 `direction=both`，置信度提高。
5. **过滤**：`127.0.0.1`、`::1`、source==target、同机内部流量不入图；容器流量保留 `container` 标记。
6. **统计**：节点/边/业务系统/外部依赖数量、总连接数、失败连接数、样本数、上报主机数。

## 7. LLM 分析

`TopologyAnalyzer.analyze(tenantId, input)`：

- 输入压缩：主机 ≤ 80、边按流量排序取 ≤ 120、外部 peer ≤ 30；节点 id 使用稳定短 id。
- 模型：`ModelCompletionService`（复用租户模型配置），system prompt 要求输出**严格 JSON**：`nodes/edges/insights/hotPaths/risks/summary/confidence`；分层固定 `ingress|app|middleware|data|external`；边只能引用输入节点。
- 校验：去 markdown 围栏、截取 JSON、逐字段校验、引用闭合、枚举白名单、数量夹取、数值非负、label 截断；模型缺失 `status/services` 时用输入补齐；模型边与真实边匹配后用真实计数覆盖（模型不得放大流量）。
- **兜底**：模型未配置/超时/输出非法 → 确定性启发式：按进程与端口分类分层（nginx/haproxy→ingress，redis/kafka→middleware，mysql/postgres→data，未纳管 IP→external），生成摘要、核心链路、失败率风险、单点风险、跨系统耦合、外部依赖 TopN。`analysis.fallback=true` 并在页面标注「规则引擎兜底」。
- 输出落库 `topology_graphs`，页面永远有图可渲染。

## 8. API

前缀 `/api/topologies`（权限 `agent.manage`，租户隔离）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/learn` | 创建固定时间窗学习会话 `{appSystemId?, windowSeconds?}` |
| GET | `/learn/active` | 当前活动会话（含进度） |
| GET | `/learn/:id` | 会话详情（进度：已上报主机、边样本数、剩余秒数） |
| POST | `/learn/:id/analyze` | 重新分析（生成新版本） |
| POST | `/learn/:id/cancel` | 取消 |
| POST | `/learn/:id/samples` | 注入窗口样本（演示/测试，校验 agent 归属） |
| GET | `/` | 拓扑图版本列表 |
| GET | `/latest` | 最新拓扑图（可按应用系统过滤） |
| GET | `/:id` | 完整拓扑图 |
| GET/PUT | `/policy` | 自动学习策略 |

自动学习：`TopologyLearningScheduler` 每 10s tick，处理到期会话；按策略 `next_run_at` 自动发起学习（`OPSAGENT_TOPOLOGY_AUTOLEARN=false` 可关）。

## 9. Web 可视化

- **主机视图**：五层分带（接入/应用/中间件/数据/外部），节点卡片展示系统色、服务端口 chips、连接/失败指标、异常；边按流量分级，top 边流光动画，失败边红色警示；hover 高亮上下游，点击聚焦 1 跳，右侧详情抽屉。
- **业务系统视图**：主机折叠为业务系统节点，系统间连线表示跨系统访问（含连接数），点击下钻。
- **分析侧栏**：LLM 摘要、核心链路（可点击高亮）、风险与洞察（可定位节点/边）、模型/置信度/兜底标识。
- **学习向导**：选择 60~1800s 窗口 → 实时进度（上报主机数/边样本/倒计时）→ 完成后自动加载新版本。
- **自动学习策略**：开关、周期、窗口、范围、下次运行时间。
- 视觉基调：深色指挥中心、点阵背景、霓虹流光、业务系统色带、玻璃拟态卡片；同时兼容浅色主题与 1440/1680 宽度。

## 10. 验收

1. Go：`go build ./... && go vet ./... && go test ./...`（Agent 边采样单测）。
2. Control：迁移幂等；`pnpm --filter @opsagent/control typecheck`；vitest（聚合纯函数 + 分析器兜底）。
3. Web：`pnpm --filter @opsagent/web typecheck && build`；设计工作台 1680×1004 / 1440×900 无截断/重叠/对比度问题。
4. 端到端：起 compose → seed → 创建学习会话 → 注入窗口样本 → 自动聚合 → 分析（模型或兜底）→ 拓扑 API 返回 → 页面渲染；记录 curl 与截图。
5. 回归：`pnpm typecheck`、`pnpm test`、`pnpm build`。

## 11. 端到端实测记录（2026-11-10，本机 compose 环境）

1. **Agent 采集（Go）**：Windows `go build/vet/test` 通过（30 个新增用例 + 既有回归）；Linux 交叉编译通过；WSL 真机把 Linux Agent 连到真实 Control：
   - 注册 `hostname=leo`，13 次心跳全部 200，`agent_connection_edges` 落 **96 条窗口样本**（in/out 方向、pid/cmdline/service、baseline 正确）；
   - 学习会话 `reportingAgents=14`（13 台 seed 主机 + 该真机），图中出现该节点，证明「真机采集 → 心跳 → 入库 → 学习 → 拓扑」全链路成立。
2. **演示数据学习（13 主机 / 37 条逻辑访问关系 / 6 个外部依赖）**：
   - 规则引擎兜底路径：`model=heuristic`、`fallback=true`、`confidence=0.65`、`insights=8`、`risks=3`，`failedConnections` 修复后为 156（原 in/out 重复累加为 200）。
   - 大模型路径（本地 OpenAI 兼容 mock，`scripts/mock-topology-model.mjs`）：`model=topology-mock`、`fallback=false`、`confidence=0.88`，边 id / hotPaths / insights 引用闭合，页面可定位。
   - 最终干净口径：窗口 120s、13 台纳管主机、**19 节点（13 主机 + 6 外部）**、**36 条主机级访问关系**（37 条服务级逻辑边在主机维度合并 1 条）、失败连接 **156**、业务系统 **3**、外部依赖 6、上报 Agent 13。
3. **页面**：`GET /api/topologies/latest` 正常返回；1680×1004 / 1440×900 截图无横向溢出、无 console 错误（仅未登录时 `/api/me` 的预期 401）；主机视图与业务系统视图、学习向导、自动学习策略面板均可交互。
4. **门禁**：`pnpm -r typecheck` 通过；control 224 项测试 223 通过（1 项既有 `agent-api` 用例因后台 inspect 指令与 pending 顺序冲突，已改为先完成其它待执行指令后断言）；Go 测试通过；Web `build` 通过。

## 12. 已知限制

- procfs 模式拿不到建链失败（`failed=0`），只有 eBPF 数据源有真实失败计数；短于采样周期（5s）的连接可能漏采。
- 纯 IPv6 连接暂不纳入（与 eBPF 实现一致，v4-mapped 已归一化）。
- 容器内进程只归因到宿主侧可见信息；容器内网络命名空间的连接依赖 eBPF 数据源补全。
- LLM 分析对超大图做了裁剪（top N），极小流量边可能被模型省略（真实边表仍完整入库）。
- 本机演示环境的「大模型路径」使用 OpenAI 兼容 mock 验证（无商用模型 Key）；生产环境在「模型配置」中添加任意 OpenAI/Anthropic 兼容模型后即走真实模型，无需改代码。
