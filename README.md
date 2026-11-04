# OpsAgent

Multi-tenant AIOps agent platform: dsh runtime + control plane + connector tools + Commander + Eino-based host agents.

> Status (2026-11-04): all current tests/build/E2E pass and the latest commit is pushed to `opsvr-ai/OpsAgent`. Delivered: G1 identity/session/approval/audit/Web, 9 connectors, scenarios/scheduler/sharing, Studio generation, knowledge/messages/data-store/long-task basics, Host Agent install/discovery/patrol/app-health/CLI/SSE/read-only exec, Commander incident evidence/hypothesis/ticket slice, auto host-inspection executor, external incident-source ingestion (generic + Alertmanager/Zabbix adapters), Markdown report, parallel connector evidence (optional ClickHouse/PostgreSQL/MySQL diagnostic SQL), R2/R3 incident approval loop, root-cause confidence convergence, automatic Commander scheduling, automatic report generation and message notification, app-system topology evidence aggregation and topology panel, competing hypotheses with automatic adjudication, scheduled read-only rechecks, Commander model analysis over incident evidence, configurable incident report templates, Ed25519-signed agent commands with nonce, expiry, key id, previous-key rotation, heartbeat key refresh, signed command results with stable, optionally encrypted result keys, per-agent command key status with stale-key visibility, audit history, stale-key alerts and public-key enrollment, automatic incident recovery closure, commander assignment, incident SLA deadlines and breach alerts, signed release verification, artifact preflight, deployment execution to agents with live end-to-end verification, canary batching and promotion, optional canary auto-promotion, health-gated deployment, automatic rollback and deployment-failure incidents, deployment approval/canary rollback records and a deployment management page, Electron desktop thin shell with secure storage bridge, Windows portable zip, NSIS installer, auto-update feed with control-plane hosting and code-signing configuration, systemd cgroup memory/CPU/IO limits, container memory/CPU limits and resource threshold events. Not complete: P1.5 Desktop code signing/local execution node, P1.6 remaining Commander polish, P2-A Eino ADK/CSR/mTLS/cgroup, P2-B deploy execution/health-gated rollback. See `docs/design/plans/2026-11-03-p1-sprint-1.md` and `docs/design/plans/2026-11-04-commander-slice.md`.

> 验收现状与阻塞项：[2026-11-04-acceptance-status.md](docs/design/plans/2026-11-04-acceptance-status.md)。
>
> mTLS 支持外部 CA 或控制面内置 CA、Agent 首次注册 CSR 自动签发、自动服务端证书、证书到期事件、吊销与 CRL 分发、吊销审计、平台证书状态页，见 [2026-11-04-mtls-transport.md](docs/design/plans/2026-11-04-mtls-transport.md)；CA 轮换仍未完成。Compose 已启用 8443 mTLS。

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
- 修改 Agent 代码后执行 `pnpm agent:dist` 重建 Linux/Windows 安装包

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
apps/control          Fastify control plane
packages/contracts    roles, permissions, theme, runtime/API contracts
runtime/              dsh bundle (next)
apps/web              React console (next)
design/               HTML design prototypes
docs/design/          architecture, plan, contracts, audits
```

## Tests

```bash
pnpm test             # unit/component tests
pnpm e2e              # Playwright G1 browser flow
pnpm build            # TypeScript builds
```

## Next

1. PostgreSQL schema + RLS + seed.
2. LDAP/local-admin auth + sessions.
3. Tenant context / multi-role guards.
4. Audit writer + redaction.
5. Fake/dsh runtime + mock tools + approvals.
6. Web login/home/theme.
7. G1 E2E.

Plan: `docs/design/plans/2026-11-03-p1-sprint-1.md`.
