# OpsAgent

Multi-tenant AIOps agent platform: dsh runtime + control plane + connector tools + Commander + Eino-based host agents.

> Status: development started. Current: G1 auth/tenant/session/approval/audit/Web, 9 connectors + config/probes, scenarios + scheduler + sharing, Studio + real dsh headless generation, Commander incident API. Dev stack runs in Docker; host dsh is intentionally not reused. Next = DshRuntime.

## 容器化开发（推荐）

服务端和 Web 都在容器里运行，宿主机上的 dsh 不会被挂载或复用：

```bash
pnpm install
docker compose run --rm seed          # 首次：初始化数据库和本地管理员
docker compose up -d control web
# http://localhost:5173
# 本地管理员：tenant-admin / opsagent-dev
```

容器内：

- `control`：Fastify，端口 8080
- `web`：Vite，端口 5173，代理 `/api` 到 `http://control:8080`
- `postgres` / `redis` / `minio`
- Studio 生成默认关闭：`STUDIO_DSH_ENABLED=false`，避免使用宿主机 dsh
- 需要容器内生成时，在镜像内安装/配置 dsh，再把该变量改为 `true`

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
