# OpsAgent

Multi-tenant AIOps agent platform: dsh runtime + control plane + connector tools + Commander + Eino-based host agents.

> Status: development started. Current: G1 auth/tenant/session/approval/audit/Web, 9 connectors + config/probes, scenarios + scheduler + sharing, Studio + real dsh headless generation, Commander incident API. Dev stack runs in Docker; dsh is installed in the control image and uses the DeepSeek account credentials copied from the host. Next = production hardening.

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
- 修改 Agent 代码后执行 `pnpm agent:dist` 重建 Linux/Windows 安装包

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
