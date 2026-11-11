# OpsAgent

Multi-tenant AIOps agent platform: dsh runtime + control plane + connector tools + Commander + Go host agents.

> Status (2026-11-05): 0.3.2 final delivery is committed and pushed. Delivered: identity/RBAC/audit/Web, 9 connectors, scenarios/scheduler/sharing, Studio, knowledge/messages/data-store/long tasks, Commander incidents/evidence/hypotheses/reports/SLA/approvals, Host Agent install/discovery/patrol/read-only exec/service lifecycle, Ed25519 signed commands, signed releases and deployments, host canary, traffic-level canary with Nginx config generation, health-gated rollback, incident report templates, Desktop thin shell and update feed, internal PKI with CSR/mTLS/CRL/OCSP, resource limits and threshold events. Evidence: 217 unit/API tests passed, 14 E2E passed, Go tests passed, build passed, Control healthy, 8443 mTLS, CRL/OCSP HTTP 200. External sign-off items and final package: [FINAL-DELIVERY.md](docs/FINAL-DELIVERY.md).

> 验收现状与阻塞项：[2026-11-04-acceptance-status.md](docs/design/plans/2026-11-04-acceptance-status.md)。
>
> 多 Agent 异常分析与协同排查：[2026-11-04-agent-collaboration.md](docs/design/plans/2026-11-04-agent-collaboration.md)。
>
> 指定 Agent 下发自然语言指令（后端 + 详情页 + SSE 流式/重连 + 批量 + 批量写审批/服务端事务批量审批/撤销/并发认领/单条与批量副作用隔离/副作用失败记录与处理 + 审批过期/通知/提前提醒/倒计时/拒绝原因 + Webhook 通知/重试/投递日志/可配置自动重放退避/失败告警/恢复通知/独立运维告警/重试/投递日志/自动重放/手工重放/通知趋势 24h-7d/趋势导出/审批历史导出/页面自动刷新 + 职责分离 + CSV + 历史 + 模板管理 + 模板可见范围 + Incident 证据联动 + Incident 页面发起 + 写审批关联 Incident + Incident 审批时间线 + 审批消息中心 + 指令列表 + 超时治理 + 取消 + 指令导出 + 报告内嵌 + 服务状态查询/启动/停止/重启/重载/启用/禁用审批/执行后状态确认与校验）：[2026-11-04-agent-instruction-routing.md](docs/design/plans/2026-11-04-agent-instruction-routing.md)。
>
> Agent 运行时长与主机概览能力：[2026-11-04-agent-capabilities.md](docs/design/plans/2026-11-04-agent-capabilities.md)。
>
> 发布说明：[RELEASE.md](docs/RELEASE.md)。
>
> mTLS 支持外部 CA 或控制面内置 CA、Agent 首次注册 CSR 自动签发、自动服务端证书、证书到期事件、吊销与 CRL 分发、标准 OCSP 响应、吊销审计、平台证书状态页、健康检查证书剩余天数和新旧 CA 过渡轮换，见 [2026-11-04-mtls-transport.md](docs/design/plans/2026-11-04-mtls-transport.md)；Compose 已启用 8443 mTLS。

## 容器化开发（推荐）

服务端、Web 和 dsh 运行时都在容器里运行。首次启动前，把宿主机已登录的 dsh 凭据同步到本地运行时目录：

```bash
pnpm install
pnpm dsh:prepare                      # 复制 ~/.dsh 凭据与 headless profile 到 .dsh-runtime/
docker compose run --rm seed          # 首次：初始化数据库和本地管理员
docker compose up -d --build control web
# http://localhost:5173
# 本地管理员：tenant-admin / opsagent-dev
```

`.dsh-runtime/` 已被 `.gitignore` 忽略，不会提交凭据。

### 安装命令中的控制面地址

「操作系统智能体」页的一键安装命令默认使用 `OPSAGENT_PUBLIC_URL`。这个地址必须是**目标 Agent 能访问到的宿主机地址**，不能是 `127.0.0.1`（那会指向 Agent 自己），也不能是 Docker 内部服务名。

先查宿主机局域网 IP：

```powershell
# Windows
ipconfig
# 取“无线局域网适配器 WLAN”或“以太网”的 IPv4 地址
```

```bash
# Linux
hostname -I
```

在项目根目录创建或修改 `.env`：

```text
OPSAGENT_PUBLIC_URL=http://10.79.4.206:8080
```

然后重建 control 容器（只 `restart` 不会重新读取 `.env`）：

```bash
docker compose up -d control
```

验证：

```bash
curl -s http://127.0.0.1:8080/api/agents/install-command?os=linux \
  -H 'cookie: ...'
```

返回的命令应包含 `http://10.79.4.206:8080/api/agents/install.sh`。

注意：

- 目标 Agent 必须能访问该 IP 的 8080 端口，必要时放行防火墙。
- 使用域名/HTTPS 反向代理时，填 `https://opsagent.example.com`。
- 修改 `.env` 后必须 `docker compose up -d control`，不能只 `docker compose restart control`。
- 不要把它配置成 `http://control:8080`，那只在 Docker 网络内部有效。

### 内网 npm / Go 代理

镜像构建时通过 build args 使用 `.env` 中的代理地址：

```text
NPM_REGISTRY=http://7.24.4.68:28081/repository/npm/
GOPROXY=https://proxy.golang.org,direct
GOSUMDB=sum.golang.org
```

- `NPM_REGISTRY` 同时用于 `npm install -g pnpm/dsh` 和 `pnpm install --frozen-lockfile`。
- Nexus/Artifactory 的 npm 代理地址末尾保留 `/repository/npm/`。
- `GOPROXY` 指向内网 Go 模块代理；私有代理可设置 `GOSUMDB=off`。
- 修改后重新构建，不能只 `docker compose up`：

```bash
docker compose build control
docker compose up -d control
```

- 如果内网没有 Go 模块代理，在有网环境构建 control 镜像后 `docker save`/`docker load` 导入。
- Nexus 私服需要认证时，把凭据放进构建环境的 `.npmrc` 或使用 BuildKit secret，不要把 token 写进镜像。

容器内：

- `control`：Fastify，端口 8080，镜像内安装 `@deepseek-ai/dsh`
- `web`：Vite，端口 5173，代理 `/api` 到 `http://control:8080`
- `postgres` / `redis` / `minio`
- dsh 使用 `deepseek-account` 路由和 `deepseek-flash` 模型
- `DSH_RUNTIME_ENABLED=true`、`STUDIO_DSH_ENABLED=true`
- dsh 工作目录固定为 `/app`；输入框可在每次提问前选择执行权限：
  - `仅可查看`：只读 Landlock 沙箱，写入被拒绝
  - `工作区内修改`：只允许修改 `/app` 工作区，工作区外写入被拒绝
  - `完全权限`：跳过人工审批，直接执行（仅受信任任务使用）
  - `自动审查 EXP`：只读命令自动放行，写入/危险命令仍进入人工审批
- `DSH_PERMISSION_MODE` 只作为默认兜底；实际权限随每次 prompt 写入会话并传给 dsh
- 审批通过 OpsAgent 内部审批 API 完成，与 dsh 的 permission picker 对齐
- 会话记录写入 `session_transcripts`；`dsh_session_id` 持久化到 `runtime_sessions`，重启后仍可继续历史会话
- 会话历史入口：智能体会话页右上角「历史」，或左侧「会话历史」页；可打开旧会话继续追问
- 操作系统智能体启动时上报操作系统配置、应用部署和 Agent 部署信息，之后每 5 分钟刷新；平台按应用系统聚合主机
- 智能体会话内置平台数据助手：可直接问「纳管了多少操作系统智能体」「检查 prod-web-01 的系统配置」；说「重新发现…」会给对应 Agent 下发命令
- 主机问题会由 Agent 执行只读检查命令 `inspect`，按问题采集磁盘分区、CPU、内存、服务、端口、进程、软件包、网络、日志、容器和 Agent 部署路径，而不是只返回固定指标
- Agent 每 30 秒自巡航磁盘/内存，异常主动上报并在「操作系统智能体」页和消息中心展示，恢复后自动关闭告警
- 异常上报会携带配置、指标、应用部署、应用日志、系统日志、进程和 Agent 日志诊断包；服务端自动触发所属应用系统的全节点健康检查并生成根因
- 支持自然语言路径排查（如「看看 /opt/opsagent/logs 目录」），Agent 执行 allowlist 内的只读命令（ls/tail/cat/grep/find/ps/ss/journalctl/docker logs/systemctl status 等），写操作默认拒绝
- 修改 Agent 代码后重新构建 control 镜像；镜像会在 `golang:1.26-alpine` 阶段自动编译三个平台二进制到 `/opt/opsagent-agent-dist`，宿主机不需要安装 Go
- 非容器开发时才需要执行 `pnpm agent:dist`，输出到 `agents/opsagent-agent/dist`

### `/opt/opsagent` 目录结构

Agent 安装后自动创建以下目录，按 Eino 的 skill / session / checkpoint 分层：

```text
/opt/opsagent/
├── bin/
│   └── opsagent-agent                 主程序
├── config/
│   └── agent.env                      Agent 配置
├── skills/
│   ├── system-overview/SKILL.md       Eino skill.LocalBackend 格式
│   ├── disk-usage/SKILL.md
│   ├── memory-usage/SKILL.md
│   ├── network-status/SKILL.md
│   ├── service-status/SKILL.md
│   ├── process-top/SKILL.md
│   ├── logs-recent/SKILL.md
│   ├── container-status/SKILL.md
│   ├── agent-health/SKILL.md
│   ├── application-discovery/SKILL.md
│   ├── ops-tools/SKILL.md
│   ├── performance-analysis/SKILL.md
│   ├── troubleshooting/SKILL.md
│   └── system-configuration/SKILL.md
├── tools/                             本地诊断工具
├── state/
│   ├── memory.json                    Agent 长期记忆
│   ├── sessions/                      Eino 会话历史
│   └── checkpoints/                   Eino Runner checkpoint
├── workspace/
│   └── scripts/                       受控脚本工作区
├── logs/agent.log
├── snapshots/                         配置/指标/巡航快照
├── audit/                             本地操作审计
└── run/                               PID 和运行时文件
```

内置技能首次启动自动写入 `skills/<name>/SKILL.md`，已存在时不覆盖。

对应 Eino 组件：

```text
skills/<name>/SKILL.md  →  adk/middlewares/skill.LocalBackend
state/checkpoints/      →  compose.CheckPointStore（fileCheckpointStore）
state/memory.json       →  Agent 长期记忆
state/sessions/         →  Eino session 持久化目录
workspace/              →  脚本和工具执行工作区
```

目录可用环境变量覆盖：

```text
OPSAGENT_SKILLS_DIR
OPSAGENT_STATE_DIR
OPSAGENT_WORKSPACE_DIR
```

旧版本的 `snapshots/memory.json` 会自动迁移到 `state/memory.json`。

### 操作系统智能体运行能力

```text
skills    system.overview / disk.usage / memory.usage / network.status /
          service.status / process.top / logs.recent / container.status / agent.health /
          application.discovery / ops.tools / performance.analysis /
          troubleshooting / system.configuration
memory    state/memory.json，保留最近 50 条检查与技能观察
script    受控脚本执行（默认关闭，需 OPSAGENT_ALLOW_SCRIPTS=true）
patrol    指标异常自动调用平台模型分析，并把分析写入异常 detail 上报
```

调用技能：

```bash
POST /api/agents/:id/commands
{ "type": "skill", "input": { "name": "network.status" } }
```

查看记忆：

```bash
POST /api/agents/:id/commands
{ "type": "memory", "input": { "limit": 20 } }
```

执行脚本（高风险，需显式开启）：

```bash
POST /api/agents/:id/commands
{ "type": "script", "input": { "script": "df -h", "timeoutSeconds": 30 } }
```

脚本命令只有 `agent.manage` 权限可下发，Agent 侧还必须设置：

```text
OPSAGENT_ALLOW_SCRIPTS=true
```

自主巡航检测到磁盘或内存阈值异常时，Agent 会请求：

```http
POST /api/agents/:id/analyze
```

控制面使用当前租户模型分析，分析结果写入异常详情后上报平台。

巡航阈值由服务端管理，可在 Agent 详情页「自主巡航」修改，或调用：

```http
PUT /api/agents/:id/patrol-policy
{
  "enabled": true,
  "intervalSeconds": 30,
  "diskFreePct": 15,
  "memLoadPct": 85,
  "load1": 0
}
```

`intervalSeconds` 最小 30 秒；`load1=0` 表示关闭负载阈值检查。

### 在会话中控制操作系统智能体

支持在智能体会话中直接下发总控指令：

```text
给 ops-dev-01 检查磁盘
批量检查所有在线主机的系统配置
给订单中心所有节点执行网络配置检查
```

- 指定主机：按 hostname/name 匹配单台 Agent
- 指定应用系统：按应用系统名称匹配该系统下全部在线节点
- 全部主机：所有在线 Agent
- 只读检查自动执行并汇总
- 写操作不会在普通对话中直接执行，需走「自然语言指令」的平台审批
- 支持多轮引用上一批任务：`重试失败节点` 只重试上一任务失败的主机
- 每个批次落库 `agent_control_tasks` / `agent_control_runs`，可通过 `/api/agent-control/tasks/:id` 查看明细

文档：`docs/design/plans/2026-11-05-agent-eino-layout.md`

操作系统智能体默认模型在「模型配置」中设置，点击模型卡片的「设为智能体默认」即可。Agent 技能分析、巡航根因分析和 CLI 分析优先使用该模型；未设置时使用最近创建的启用模型。

### 运维技能管理

侧栏「运维技能」集中管理：

- 内置技能：Agent 注册/心跳上报 `SKILL.md` 内容，平台自动同步
- 自定义技能：平台创建，可下发到全部在线主机、指定应用系统或指定主机
- 下发后写入目标 Agent 的 `/opt/opsagent/skills/<name>/SKILL.md`
- 更新自定义技能后重新同步即可覆盖

应用系统可在「操作系统智能体 → 应用系统视图」点击「新增应用系统」，再在 Agent 详情中归属主机。

### 平台数据查询

会话中的平台数据问题由 `PlatformAssistant` 直接查询控制面数据库，不经过 Agent 或 dsh：

- `纳管了哪些应用系统` → 应用系统清单、负责人、等级、在线/总数
- `当前纳管了多少操作系统智能体` → 主机清单和在线状态
- `当前有哪些告警` → 活跃告警
- 应用系统健康、根因、事件等走对应查询

结果以结构化摘要返回，不输出原始数据库内容。

### 资产上报与重要对象巡航

Agent 首次注册和每 5 分钟发现会上报：

```text
服务、应用进程、监听端口、运维工具
```

服务端写入 `agent_inventory`，在 Agent 详情「巡检对象」中可以标记：

```text
重要
监控
```

被标记为“重要 + 监控”的进程、端口、服务会进入该 Agent 的巡航 watchlist。缺失时自动生成：

```text
重要进程未运行 / 重要端口未监听 / 重要服务未运行
```

异常事件会携带平台模型分析，并触发应用系统健康检查与故障定界（Agent 需归属应用系统）。

### 故障定界分析

侧栏「故障定界」与智能体会话同级，按应用系统聚合异常：

1. 汇总该系统全部节点的 open 异常、指标、重要巡检对象
2. 模型分析根因、影响范围
3. 需要补证时自动调度对应 Agent 执行 inspect（日志、进程、端口）
4. 合并补充证据，由总调度智能体输出最终根因和置信度

API：

```text
GET  /api/fault-analyses
GET  /api/fault-analyses/:id
POST /api/fault-analyses {appSystemId}
```

Agent 异常事件上报后自动触发；同一应用系统已有运行中分析时复用，不重复创建。

### 访问拓扑自动学习（2026-11-10）

操作系统智能体不再只上报点状 netstat 快照，而是参考 eBPF 采集器 `conn_collector` 的原理，按固定时间窗输出**建连边表**：

- Agent 每 5s 采样 `/proc/net/tcp{,6}`，按 10s 窗口聚合 `opened / closed / failed / active`，随 10s 心跳的 `connectionWindows` 字段上报；
- 采集侧完成 listen 端口→进程归因、方向判定（out/in）、本机回环与同机内网流量过滤、启动基线（连接池长连接）、容器短 ID 识别；
- 若主机部署了 `conn_collector`（eBPF），Agent 自动读取 `/var/log/conn_collector/edges.json` 的精确 opened/closed/failed 并合并（`source=ebpf|hybrid`）；
- 控制面把窗口样本写入 `agent_connection_edges`（幂等 upsert），学习会话结束后聚合为「谁在什么时间访问了谁、多少连接、失败多少」，交给服务端大模型分析（模型未配置/超时自动回落规则引擎，图始终可渲染）；
- 学习结果按不可变版本存 `topology_graphs`，Web「访问拓扑」页以分层画布 + 业务系统色带 + 流水线动效展示，支持主机视图/业务系统视图、聚焦上下游、异常链路、LLM 摘要与风险洞察。
- **V2（2026-11-10）**：按 IT 架构精确分层为「接入层 / 应用层 / 中间件层 / 数据层 / 运维观测层 / 外部依赖」；节点带 `product`（Nginx、Spring Boot、MySQL、Redis、Kafka、Prometheus 等）、`role`（接入网关、业务应用、关系型数据库、缓存、消息队列、监控…）与 `systemService` 标记。大模型基于「监听端口 + 进程命令行 + 建连证据」识别组件并分层，规则引擎兜底保持同口径。
- 学习**默认只纳入归属应用系统的主机**（`includeUnassigned=false`），未归属主机不再混入拓扑；需要时可在学习向导/自动学习策略中显式打开。大模型 prompt 压缩预算 ≤45k 字符（适配 32k/64k 上下文），模型不可用时自动回落规则引擎。
- **V3（2026-11-10 晚）拓扑可读性重构**：边按节点对聚合（实测原始 72 条边默认展示 28 条），**边标签只在悬停/选中时显示**；默认过滤管理流量（SSH/Zabbix/Node Exporter/Prometheus/Grafana/Agent 自身）与低流量边，可在「显示设置」恢复；外部依赖按 IP 聚合 + topN（默认 8 个）+「其他外部依赖」；节点卡紧凑（product/role + 主端口 + N 项服务），服务明细进详情；支持**全屏模式**；**点击节点进入聚焦态**，右侧展示「入站/出站关联节点」并可点击切换；缩放 30%~300%。**切换「范围」到某个应用系统时，画布只保留该系统的主机、外部依赖与跨系统边界节点（其他系统聚合），不再混入其他系统的内部拓扑**。
- **V4（2026-11-11）运维交互与量化**：
  - 全屏 + 缩放上限 **500%**（滚轮/按钮/1:1/适应/全图），大图细节可读；
  - **节点可拖动**，拖动时实时重算连线并高亮 1 跳关联节点/边、其余淡化，松手保留位置，「重置布局」恢复自动布局；
  - **访问关系标签**：可按关系（源主机→目标主机:端口，`relationKey` 跨版本稳定）打「运维工具 / 应用调用 / 数据访问 / 中间件访问 / 外部依赖」等标签，支持颜色、类别过滤、边 tooltip/节点详情/趋势表展示；标签持久化到 `topology_edge_tags`；
  - **访问量分析**：24h/7d、小时/天分桶，表格按访问次数/失败排序，含 SVG 趋势 sparkline、Top 链路、建议标签一键采纳、点击行在画布定位对应边；访问次数口径为 **Agent 每 10s 窗口统计的 TCP 建连次数（opened 合计，不是 HTTP 请求数）**。
- **V5（2026-11-11）HTTP/gRPC 请求级计数 + 大模型自动打标签**：
  - **Agent 0.7.0** 新增明文七层旁路观察器（AF_PACKET）：HTTP/1 请求行、HTTP/2 HEADERS、gRPC（按 50051/9090 端口/服务名识别），按 10s 窗口通过心跳 `httpRequestWindows` 上报；支持 `OPSAGENT_HTTP_METRICS`（默认 true）/`OPSAGENT_HTTP_IFACE`/`OPSAGENT_GRPC_PORTS`/`OPSAGENT_HTTP_MAX_EDGES`/`OPSAGENT_HTTP_WINDOW_SECONDS`/`OPSAGENT_HTTP_DEBUG`。**仅明文 HTTP/1、h2c、明文 gRPC；HTTPS/gRPC-TLS/HTTP3 无法解密不计数；需要 root/CAP_NET_RAW，权限不足自动禁用**。详见 [agents/opsagent-agent/README-http-metrics.md](agents/opsagent-agent/README-http-metrics.md)。
  - Control 新增 `agent_http_requests`（迁移 0081，保留 7 天），Web「访问量分析」可切换 **TCP 建连 / HTTP/gRPC 请求**，请求视图显示协议、方法、请求数、失败、sparkline，24h/7d 自动小时/天桶。
  - **AI 自动打标签**：`POST /api/topologies/edge-tags/suggest` 把访问关系摘要交给大模型，输出标签/类别/置信度/原因；模型不可用自动规则兜底（运维工具/外部依赖/数据访问/中间件访问/应用调用），Web 建议弹层支持全选/单选采纳，落库 `source='model'`；无模型时可手动打标签。
  - **分析过程 trace（排障）**：每次拓扑分析记录「解析默认模型 → 组装 prompt → 调用模型 → 解析/校验 → 生成/兜底」五步（含模型名/provider/Base URL、prompt 统计、请求耗时/HTTP 状态/响应字符、响应片段、error code/message、fallbackReason），随图持久化；Web 分析侧栏「查看分析过程」可展开完整过程、复制响应片段；模型不可用时直接显示具体错误（如 `model_fetch_failed:ECONNREFUSED`、`model_http_401`、`model_json_invalid`）。

API（权限 `agent.manage`）：

```text
POST /api/topologies/learn            { appSystemId?, windowSeconds, includeUnassigned? }  # 60~1800s
GET  /api/topologies/learn/active
GET  /api/topologies/learn/:id
POST /api/topologies/learn/:id/analyze
POST /api/topologies/learn/:id/cancel
POST /api/topologies/learn/:id/samples # 演示/测试注入窗口样本
GET  /api/topologies                  # 版本列表
GET  /api/topologies/latest           # 最新拓扑（无图返回 null）
GET  /api/topologies/:id
GET|PUT /api/topologies/policy        # 自动学习策略（含 includeUnassigned）
GET|POST /api/topologies/edge-tags    # 访问关系标签（GET 列表 / POST upsert）
DELETE /api/topologies/edge-tags/:id  # 删除标签
GET  /api/topologies/access-trends    # 访问量趋势 ?windowHours=24&bucket=hour&appSystemId=
GET  /api/topologies/http-requests    # HTTP/gRPC 请求趋势 ?windowHours=24&bucket=hour&appSystemId=
POST /api/topologies/edge-tags/suggest # AI 自动打标签建议 {appSystemId?, relationKeys?}
```

自动学习：控制面 `TopologyLearningScheduler` 每 10s 处理到期会话与策略；`OPSAGENT_TOPOLOGY_AUTOLEARN=false` 可关闭。Agent 可用 `OPSAGENT_CONN_EDGES=false` 关闭采集，或用 `OPSAGENT_CONN_SAMPLE_INTERVAL_SECONDS` / `OPSAGENT_CONN_WINDOW_SECONDS` / `OPSAGENT_CONN_COLLECTOR_DIR` 调整；HTTP/gRPC 请求计数用 `OPSAGENT_HTTP_METRICS=false` 关闭（默认开启，权限不足自动禁用）。

本地演示数据（13 主机 / 3 业务系统 / 37 条访问关系，含失败链路）：

```bash
docker compose exec -T control pnpm --filter @opsagent/control seed:topology
```

文档：[2026-11-10-topology-learning.md](docs/design/plans/2026-11-10-topology-learning.md)、[Agent 窗口采集](docs/design/plans/2026-11-10-agent-connection-windows.md)。

#### 配置了模型，拓扑仍提示「规则引擎兜底」？

1. 已生成的拓扑图是**不可变快照**，配置模型不会自动重算旧图。需要二选一：
   - 在「访问拓扑」分析侧栏点「用当前模型重新分析」（复用该图对应学习会话的窗口样本），或
   - 用「学习向导」重新学习一个时间窗口。
2. 先到「模型配置」对目标模型点「测试连接」；或在拓扑分析侧栏的兜底提示里点「测试当前模型」（与拓扑分析器使用完全相同的默认模型解析，能直接看到实际生效的模型和错误）：
   - 成功会显示延迟与返回片段；失败会显示真实原因（如 `fetch failed` = 控制面访问不到 Base URL；`model_http_401` = API Key；`model_http_404` = 路径/模型 ID 不对；`model_timeout` = 模型太慢/超时）。
   - 有多个模型时，把测试成功的那个设为「智能体默认」——拓扑分析默认使用它。
   - 对应 API：`POST /api/models/:id/test`（指定模型）、`POST /api/models/test-default`（拓扑同款默认模型）。
3. 旧图不会自动带上新的失败原因：在分析侧栏点「用当前模型重新分析」后，若仍兜底会显示具体 `模型调用失败原因`（如 `model_json_invalid`、`model_timeout`、`model_nodes_empty`）。
3. 拓扑分析默认超时 120s、输出上限 4096 tokens；失败时分析面板的兜底提示会附带具体原因（`模型不可用，已使用规则引擎生成（...）`）。
4. 控制面日志：`docker compose logs --tail=200 control | grep -E '\[topology\]|model test failed'`。

#### 内网部署后看不到「访问拓扑」？

该页面是**前端新增页面**，只更新 control（后端）不会出现；必须把 Web 前端重新构建/部署，并强刷浏览器。排查顺序：

1. 确认内网机器上的代码版本：
   ```bash
   git log -1 --oneline            # 应包含 feat(topology)（ca846f2 或更新）
   grep -n "访问拓扑" apps/web/src/routes/nav.ts   # 应有一行输出
   ```
2. **源码挂载的 compose 部署**（本仓库 `compose.yaml`，/app 挂载宿主机源码）：
   ```bash
   git pull
   docker compose restart web       # 让 Vite 重新读取源码（避免旧模块缓存）
   # 仍不出现再重建一次：
   docker compose up -d --build --no-deps web
   ```
   然后浏览器 `Ctrl+F5`。入口在登录后的左侧「工作空间 → 访问拓扑」；`/?demo=topology` 仅开发模式可用。
3. **静态产物部署**（nginx / 自行托管 `apps/web/dist`）：
   ```bash
   pnpm install
   pnpm --filter @opsagent/web build
   # 将 apps/web/dist 发布到站点根目录；清 CDN/浏览器缓存后强刷
   grep -r "访问拓扑" apps/web/dist/assets/*.js   # 构建产物应能搜到
   ```
4. **离线镜像部署**（内网服务器没有源码挂载，直接跑镜像）：
   ```bash
   # 构建机（需能联网装依赖）：
   docker compose build control web
   docker save opsagent-local-control:latest opsagent-local-web:latest | gzip > opsagent-images-$(date +%Y%m%d).tgz
   # 内网服务器：
   docker load -i opsagent-images-*.tgz
   docker compose up -d --no-deps control web
   ```
   注意：`compose.yaml` 默认把源码挂载到 `/app`；若内网部署去掉了挂载，必须使用**重新构建过的镜像**，否则运行的还是旧代码。
5. 如果是新库/新租户，还需要至少跑一次学习（或 `seed:topology`）才会有拓扑图；页面本身在无图时显示空态引导，侧栏入口不受数据影响。

### 日志排查

控制面默认输出结构化请求日志：

```bash
docker compose logs -f --tail=200 control
```

关键前缀：

```text
[dsh] start       会话、provider、model、cwd
[dsh] stderr      dsh 子进程错误输出
[dsh] timeout     dsh 超时
[dsh] exited      dsh 退出码、耗时、stderr 尾部
[dsh] completed   dsh 完成、耗时
[runtime] prompt  每次模型调用的 provider/model/baseURL
[runtime] dsh turn failed / dsh event error
```

调整日志级别：

```text
LOG_LEVEL=debug
OPSAGENT_LOG_REQUESTS=true
```

API Key、Cookie、Authorization 会脱敏；提示词正文不写入日志。

排查模型问题时重点关注：

```bash
docker compose logs --tail=200 control | grep -E '\[dsh\]|\[runtime\]'
```

在容器中部署一个受管 Agent（开发验证用）：

```bash
docker compose -f compose.yaml -f compose.agent.yaml --profile agent up -d os-agent
```

Agent 的入站端口为零，仅主动连接 `http://control:8080`；运行日志用 `docker logs opsagent-os-agent` 查看。

Linux 主机标准安装目录为 `/opt/opsagent`：

```text
/opt/opsagent/
├── bin/opsagent-agent       主程序
├── config/agent.env         配置
├── tools/                   诊断辅助工具
├── logs/agent.log           详细执行日志
├── snapshots/               配置/性能/自巡航/命令快照
└── run/
```

日志记录启动、注册、心跳、HTTP 请求、自巡航、命令输入与执行、结果上传和错误；配置 `/etc/logrotate.d/opsagent` 每日轮转并保留 14 份。Windows 使用 `C:\ProgramData\OpsAgent` 下的同名目录结构。

安装脚本会把 `/opt/opsagent/bin` 写入 `/etc/profile.d/opsagent.sh` 并创建 `/usr/local/bin/opsagent-agent` 链接。重新登录（或 `source /etc/profile.d/opsagent.sh`）后直接执行：

```bash
opsagent-agent
```

CLI 使用 SSE 接收状态和回答增量，检查执行、模型生成过程会实时显示；后台服务使用 `opsagent-agent --service`，`--version`、`--help` 可查看版本和用法。

CLI 对话链路：

```text
opsagent-agent
  → POST /api/agents/:id/chat（Agent Key 鉴权）
  → PlatformAssistant 选择平台查询 / 应用健康 / 主机检查工具
  → 主机检查通过 agent_commands 下发到目标机
  → DshRuntime + deepseek-flash 基于真实检查证据生成回答
  → 返回 CLI 并保持多轮会话
```

智能体框架代码位于 `apps/control/src/runtime/dsh.ts`、`session-service.ts` 和 `assistant/platform.ts`；目标机上的 Go Agent 负责执行只读探针，不直接持有模型密钥。

宿主机直跑（不推荐，可能和宿主机 dsh 冲突）：

```bash
pnpm --filter @opsagent/control dev
pnpm --filter @opsagent/web exec vite --host 127.0.0.1 --port 5173
curl http://localhost:8080/healthz
```

## Layout

```text
apps/control          Fastify control plane, migrations, PKI/OCSP, deployments
apps/web              React console and built-in user manual
packages/contracts    roles, permissions, theme, runtime/API contracts
agents/opsagent-agent Go host agent (Linux/Windows)
apps/desktop          Electron thin shell and update feed
design/               HTML design prototypes
docs/design/          architecture, plans, contracts, acceptance, audits
docs/FINAL-DELIVERY.md 0.3.2 final delivery package
```

## Tests

```bash
pnpm test             # unit/API/component tests
pnpm e2e              # Playwright browser flows
pnpm build            # TypeScript builds
cd agents/opsagent-agent && go test ./...
```

## Delivered

```text
identity / tenant / RBAC / audit / Web
9 connectors, scenarios, scheduler, reports, sharing
Studio generation and sandbox install
knowledge, messages, data store, long tasks
Commander incidents, evidence, hypotheses, reports, SLA, approvals
Host Agent install/discovery/patrol/read-only exec
service status + start/stop/restart/reload/enable/disable approval
Ed25519 signed commands and results
signed releases, preflight, host canary, traffic-level canary
health-gated deployment, automatic rollback and incident
internal CA, CSR/mTLS, CRL, OCSP, certificate rotation/revocation
systemd/container/Windows Job Object resource limits
Desktop portable/NSIS builds and update feed
```

## Documentation

- [Final delivery](docs/FINAL-DELIVERY.md)
- [G0–G10 acceptance package](docs/design/plans/2026-11-04-acceptance-status.md)
- [Release notes](docs/RELEASE.md)
- [User manual](apps/web/src/content/user-manual.md)
- [mTLS / CRL / OCSP](docs/design/plans/2026-11-04-mtls-transport.md)
- [Release and traffic canary](docs/design/plans/2026-11-04-release-deployment.md)
- [Agent resource limits](docs/design/plans/2026-11-04-agent-resource-limits.md)

## External sign-off

Code and automated acceptance are complete. The remaining items require an
external environment or a human signature:

```text
G0 dsh compatibility sign-off
10-host mixed Linux lab
Windows Job Object load test on a real Windows host
enterprise code-signing certificate
production ingress applying generated Nginx canary config
production OCSP/AIA domain and firewall
security / operations / product sign-off
```

See [FINAL-DELIVERY.md](docs/FINAL-DELIVERY.md) for the full list.
