# OpsAgent

Multi-tenant AIOps agent platform: dsh runtime + control plane + connector tools + Commander + Go host agents.

> Status (2026-11-05): 0.3.2 final delivery is committed and pushed. Delivered: identity/RBAC/audit/Web, 9 connectors, scenarios/scheduler/sharing, Studio, knowledge/messages/data-store/long tasks, Commander incidents/evidence/hypotheses/reports/SLA/approvals, Host Agent install/discovery/patrol/read-only exec/service lifecycle, Ed25519 signed commands, signed releases and deployments, host canary, traffic-level canary with Nginx config generation, health-gated rollback, incident report templates, Desktop thin shell and update feed, internal PKI with CSR/mTLS/CRL/OCSP, resource limits and threshold events. Evidence: 217 unit/API tests passed, 13 E2E passed, Go tests passed, build passed, Control healthy, 8443 mTLS, CRL/OCSP HTTP 200. External sign-off items and final package: [FINAL-DELIVERY.md](docs/FINAL-DELIVERY.md).

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
