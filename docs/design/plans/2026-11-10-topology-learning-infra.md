# 访问拓扑学习：本地平台栈、数据与验收手册

> 状态：环境已就绪 + 端到端已跑通（2026-11-10 13:20 更新）；本文随验收更新。
>
> 关联：`docs/design/plans/2026-11-10-topology-learning.md`（总体设计）、
> `docs/design/plans/2026-11-10-topology-learning-demo-data.md`（演示数据集）。

## 1. 摘要

- 本地 compose 栈（项目名 `opsagent-local`）已用**已有镜像**拉起，未重建镜像、未删数据卷：
  postgres / redis / control / web 全部 Up，control、postgres、redis healthy。
- 端口：**control 8080**（HTTP）、**8443**（mTLS，需客户端证书）、**web 5173**、postgres 5432、redis 6379。
- 已执行 `seed:dev`（DROP schema + 全量迁移 + 基础数据 + 本地管理员密码）、`seed:demo`（演示业务数据）
  与 `seed:topology`（13 台主机 + 37 条逻辑边的拓扑演示数据）。
- **端到端已跑通（两条分析路径都验证过）**：
  - 大模型路径（mock server，**最终验收图**）：`model=topology-mock`、19 节点 / 36 边 / 8 条失败边 /
    失败连接 156 / 3 条洞察 / 置信度 0.88，`seed:topology` EXIT=0；
  - 启发式兜底路径（mock 接入前）：`model=heuristic`、`fallback=true`、19 节点 / 36 边 / 8 条失败边 /
    8 条洞察 / 置信度 0.65（当时的 failed 200 是旧计数口径，修复后应为 156）。
  详见 §8.3 与 §8.4。
- **模型配置**：`model_providers` 里有 1 条 `本地拓扑分析 mock`（OpenAI 兼容，
  `http://host.docker.internal:9099/v1`，model=`topology-mock`），**13:50 已置为 `disabled`**（避免 mock 停止后
  45s 超时）；之后新的学习请求会走启发式兜底（约 10s 内完成），**已生成的最新图 d0969a4c 不变**。
- **最终门禁（Lead 2026-11-10 13:56 复核）**：`pnpm e2e` **14 passed (39.9s) EXIT=0**、
  `pnpm typecheck` 全绿、`pnpm build` 全绿、control `221 passed / 3 skipped`、Go `build/vet/test` 全绿；
  页面 1680×1004 / 1440×900 复核：audit issueCount=0、无横向溢出、无 console error
  （只有登录前 `/api/me` 的预期 401）。
- 登录已实测通过，命令见 §7；无 UI 的完整 curl 验收集合见 §8。
- 页验收：`/topology` 真实数据页可渲染（19 节点/36 链路/分析侧栏/版本列表），
  页面显示、统计与模型徽标均已通过（§8.5）；设计工作台的无头浏览器在本页会退出（§10.13），
  已改用 Playwright + Edge 按 1680×1004 / 1440×900 截图人工核验。
- 重要坑：`docker compose run --rm seed` 不可用、`migrate` 不能在已有库上整体重放、
  根 `pnpm test` 引用了不存在的 `scripts/ensure-test-db.mjs`、web 容器 Vite 不会热更新宿主机改动（§10）。

## 2. 环境

| 项 | 值 |
| --- | --- |
| 工作目录 | `E:\dev\OpsAgent`（Windows） |
| Docker | engine 29.9.2，compose v5.6.1 |
| Node / pnpm | node v24.15.0（容器内 node 22）/ pnpm 11.4.0 |
| Go | go1.26.3 windows/amd64 |
| compose 项目 | `opsagent-local`（`compose.yaml`） |
| 已有镜像 | `opsagent-local-control:latest`、`opsagent-local-web:latest`、`opsagent-local-seed:latest`、`pgvector/pgvector:pg16`、`redis:7-alpine`、`postgres:16-alpine` |
| 本地 env | `.env`：`OPSAGENT_PUBLIC_URL=http://10.79.4.206:8080`（agent 安装/回调地址用） |

> **约定：不要重建镜像、不要 `docker compose down -v`、不要删数据卷**（团队共用）。
> `seed`、`minio`、`mysql-test` 在 compose 里带 profile，默认不随 `up` 启动。

## 3. 服务状态与端口

```text
NAME                        IMAGE                    STATUS                   PORTS
opsagent-local-control-1    opsagent-local-control   Up (healthy)             0.0.0.0:8080->8080/tcp, 0.0.0.0:8443->8443/tcp
opsagent-local-postgres-1   pgvector/pgvector:pg16   Up (healthy)             0.0.0.0:5432->5432/tcp
opsagent-local-redis-1      redis:7-alpine           Up (healthy)             0.0.0.0:6379->6379/tcp
opsagent-local-web-1        opsagent-local-web       Up                       0.0.0.0:5173->5173/tcp
```

| 服务 | 容器内命令 | 健康检查 |
| --- | --- | --- |
| control | `pnpm --filter @opsagent/control exec tsx watch src/index.ts` | `GET /healthz`（10s 间隔） |
| web | `vite --host 0.0.0.0 --port 5173` | 无 healthcheck；`curl -I :5173` |
| postgres | `pg_isready -U opsagent -d opsagent` | 5s 间隔 |
| redis | `redis-cli ping` | 5s 间隔 |

## 4. 启动与健康检查

```powershell
# 1) 数据面（轮询到 healthy：postgres 5432 / redis 6379）
docker compose up -d --no-build postgres redis
1..12 | ForEach-Object { docker compose ps --format '{{.Service}} {{.Status}}'; Start-Sleep -Seconds 3 }

# 2) 控制面 + Web（不重建镜像；web 依赖 control healthy）
docker compose up -d --no-build control web
docker compose ps

# 3) 健康检查
curl.exe -s http://127.0.0.1:8080/healthz
# {"status":"ok","service":"opsagent-control","tls":{"configured":true,"validTo":"Feb  2 13:00:10 2027 GMT","daysRemaining":84}}
curl.exe -s -o NUL -w "web=%{http_code}`n" http://127.0.0.1:5173/
# web=200

# 4) 看日志（启动横幅应包含 listening on :8080 / TLS listening on :8443）
docker compose logs --tail=120 control
```

control 启动日志关键行：

```text
Server listening at http://127.0.0.1:8080
opsagent-control TLS listening on :8443
opsagent-control listening on :8080
```

> Web 容器日志里若有历史 `exit code 143`（3 天前旧运行的 vite 被杀）可忽略；当前
> `docker inspect opsagent-local-web-1 --format '{{.RestartCount}}'` 为 0，vite 进程正常。

## 5. Seed 流程与当前数据

### 5.1 顺序（重要）

`seed:dev` 会 **`DROP SCHEMA public CASCADE`** 重建数据库，因此必须最先跑，然后才是 `seed:demo`
和拓扑演示数据。整体重置 = 依次重跑三者。

```powershell
# seed:dev（等价于 compose 的 seed 服务）：DROP schema → 全量迁移 → 基础数据 → 设置本地管理员密码
docker compose exec -T control pnpm --filter @opsagent/control seed:dev
# seeded dev database; local admins: tenant-admin, platform-admin

# seed:demo：业务演示数据（3 应用系统 / 4 agent / 事件 / 场景 / 知识库 ...）
docker compose exec -T control pnpm --filter @opsagent/control seed:demo
# demo data seeded

# seed:topology（拓扑演示数据，Lead 加 package.json 脚本后可用；见 demo-data 文档）
docker compose exec -T control pnpm --filter @opsagent/control exec tsx scripts/seed-topology-demo.ts
```

> **不要用** `docker compose run --rm seed`：`--no-build` 不是 `compose run` 的 flag；去掉后
> seed 镜像是旧构建（6 天前），pnpm 的 verify-deps 会触发 `pnpm install`，匿名卷 node_modules
> 与当前 lockfile 不一致又无 TTY，直接报
> `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。用 `docker compose exec control` 复用 control
> 容器里已装好的 node_modules（与 `seed` 服务命令等价）。

### 5.2 当前数据快照（2026-11-10 13:43 最终态）

| 表 | 行数 | 说明 |
| --- | --- | --- |
| tenants | 2 | tenant-demo / tenant-other |
| users | 8 | 3 基础用户（platform-admin / tenant-admin / sre-dba）+ 5 演示成员 |
| memberships | 7 | |
| agents | **13** | 4 台来自 seed:demo + 9 台来自 seed-topology-demo（全部 status=online、last_seen=now()） |
| app_systems | 3 | 订单中心 / 支付网关 / 基础运行平台 |
| agent_inventory | 65 | 22 个监听端口 ×2 行(0.0.0.0:port / ip:port) + 24 个进程（同名 java 折叠 3 条） |
| connectors | 9 | prometheus/postgres/zabbix/redis/grafana/alertmanager/clickhouse/ssh/http |
| scenarios | 6 | |
| incidents | 3 | |
| agent_connection_edges | **804** | 最终验收会话（8fc1de1b）的 13 主机 × 12 窗口样本；历史会话样本已被 Lead 的 seed:dev 重置 |
| topology_learning_sessions | **1** | 8fc1de1b…（120s，ready，model=topology-mock） |
| topology_graphs | **1** | d0969a4c…（v1，19 节点 / 36 边 / failed 156） |
| model_providers | **1** | `本地拓扑分析 mock`（openai，host.docker.internal:9099，model=topology-mock）；**13:50 起 status=disabled**，新学习请求走启发式兜底 |

> 历史记录：13:18 前后还验证过 heuristic（fallback=true）与 llm 占位两条路径，样本/图在 13:31 的
> seed:dev 重置中清空，数值保留在 §8.3/§8.4 作为对照。

13 台主机与 37 条演示边的明细见 `...-demo-data.md`。

## 6. 迁移机制（结论：控制面启动不会自动迁移）

- `apps/control/src/db/migrate.ts`：按文件名排序读取 `migrations/*.sql` 并**逐文件整体执行**；
  **没有 schema_migrations 表、没有版本判定**。
- `apps/control/src/index.ts` 与 `server.ts` **都没有调用 `migrate()`**；只有 `scripts/seed-dev.ts`
  和测试文件调用。因此“迁移会在每次控制面启动时重放”的设计注释与实现不一致。
- 迁移**不能**在已有库上整体重放：第一个迁移就 `CREATE TABLE tenants`（无 IF NOT EXISTS），
  实测报 `relation "tenants" already exists (42P07)`。
- 结论：
  - 全新环境 / 需要整体重置 → `seed:dev`（会 DROP schema，然后全量迁移）。
  - **只补一个新迁移** → 单独执行该文件，不要跑整个 migrate：
    ```powershell
    docker compose cp apps/control/migrations/0077_xxx.sql postgres:/tmp/0077_xxx.sql
    docker compose exec -T postgres psql -U opsagent -d opsagent -v ON_ERROR_STOP=1 -f /tmp/0077_xxx.sql
    ```
    已用 `0076_topology_learning.sql` 实测：重复执行只有 `NOTICE ... already exists, skipping`，退出码 0。
  - 迁移文件必须保持幂等（`CREATE TABLE IF NOT EXISTS` / `DROP POLICY IF EXISTS` / `ADD COLUMN IF NOT EXISTS`）。
- 0076 的 4 张表当前都在：`agent_connection_edges`、`topology_learning_sessions`、`topology_graphs`、
  `topology_learning_policies`（均带 RLS + FORCE ROW LEVEL SECURITY）。

## 7. 登录与鉴权命令（已实测）

- 登录接口：`POST /api/auth/local-admin`，body `{username, password, remember?}`；
  成功返回 `{"ok":true}` 并 `Set-Cookie: opsagent_session=...; HttpOnly; SameSite=Lax; Max-Age=604800`。
- 本地管理员（seed:dev 写入密码哈希，密码来自 `LOCAL_ADMIN_PASSWORD`，默认 `opsagent-dev`）：
  `tenant-admin`、`platform-admin`。
- `GET /api/me` 返回用户 + 租户 + 角色 + 权限；拓扑 API 需要权限 `agent.manage`（`tenant-admin` 具备）。
- 其他登录方式：`POST /api/auth/ldap`（未配置 LDAP 时 503）、`POST /api/auth/logout`。

```powershell
$jar = Join-Path $env:TEMP 'opsagent-cookies.txt'
Remove-Item $jar -ErrorAction SilentlyContinue

curl.exe -s -i -c $jar -H "content-type: application/json" `
  -d '{\"username\":\"tenant-admin\",\"password\":\"opsagent-dev\",\"remember\":true}' `
  http://127.0.0.1:8080/api/auth/local-admin
# HTTP/1.1 200 OK + set-cookie: opsagent_session=...

curl.exe -s -b $jar http://127.0.0.1:8080/api/me
# {"user":{"username":"tenant-admin",...},"tenants":[{"slug":"tenant-demo","roles":["tenant_admin"],"permissions":[...,"agent.manage",...]}]}

curl.exe -s -b $jar http://127.0.0.1:8080/api/app-systems
# [{"code":"payment-gateway",...,"agentCount":6,"onlineCount":0},{"code":"order-center",...,"agentCount":5,"onlineCount":0},{"code":"platform-runtime",...,"agentCount":2,"onlineCount":0}]
# 注：onlineCount 按 last_seen >= now()-90s 计算；演示主机没有真实心跳，seed 后约 90s 就会变 0。
#     拓扑演示脚本在学习阶段结束时会刷新 last_seen（见 demo-data 文档），但页面验收到打开仍需尽快。

curl.exe -s -b $jar http://127.0.0.1:8080/api/agents
# 裸数组，13 台主机（含 system_info / applications / metrics）
```

> cookie 有效期默认 8h（`remember=true` 7 天）。Windows PowerShell 下注意 `curl.exe` 与 `curl`
> 别名区别；JSON 里双引号需转义（或用 `-d @file.json`）。
> web 端同源代理：`http://127.0.0.1:5173/api/*` → control（VITE_API_PROXY=http://control:8080）。

## 8. 无 UI 的 curl 验收集合

### 8.1 当前已可用的接口（T0 基线）

```powershell
curl.exe -s -b $jar http://127.0.0.1:8080/healthz
curl.exe -s -b $jar http://127.0.0.1:8080/api/me
curl.exe -s -b $jar http://127.0.0.1:8080/api/app-systems
curl.exe -s -b $jar http://127.0.0.1:8080/api/agents            # 13 台主机（含 system_info/applications）
```

### 8.2 拓扑学习全链路（T2 已上线，实测可用）

```powershell
# ① 创建固定时间窗学习会话（60~1800s；不传 appSystemId 表示整个租户）
curl.exe -s -b $jar -H "content-type: application/json" -d '{"windowSeconds":120}' `
  http://127.0.0.1:8080/api/topologies/learn
# => 会话对象，含 id / status=collecting / startedAt / endsAt / progress

# ② 查进行中会话与进度
curl.exe -s -b $jar http://127.0.0.1:8080/api/topologies/learn/active
curl.exe -s -b $jar http://127.0.0.1:8080/api/topologies/learn/<sessionId>

# ③ 注入窗口样本（演示/测试专用；body = { agentId, windows }）
#    完整示例见 demo-data 文档 §6.3；脚本 seed-topology-demo.ts 会自动生成 13 台主机 × 12 窗口
$body = @{
  agentId = 'b0000000-0000-4000-8000-000000000002'
  windows = @(@{
    start = '2026-11-10T05:01:00.000Z'; end = '2026-11-10T05:01:10.000Z'; source = 'procfs'
    edges = @(@{
      direction='out'; process='java'; pid=5140; service='order-service'
      command='java -jar /opt/order/order-service.jar'
      localAddress='10.20.8.34'; localPort=41007; peerAddress='10.20.9.12'; peerPort=8080
      protocol='tcp'; opened=53; closed=51; failed=0; active=0; baseline=$false; container=''
    })
    stats = @{ scans = 2; activeConnections = 0; dropped = 0 }
  })
} | ConvertTo-Json -Depth 8
$body | Out-File -Encoding utf8 $env:TEMP\samples.json
curl.exe -s -b $jar -H "content-type: application/json" -d "@$env:TEMP\samples.json" `
  http://127.0.0.1:8080/api/topologies/learn/<sessionId>/samples

# ④ 等会话窗口结束 + 自动聚合 + 分析（轮询到 ready）
curl.exe -s -b $jar http://127.0.0.1:8080/api/topologies/learn/<sessionId>

# ⑤ 查最新拓扑图 / 列表 / 指定版本
curl.exe -s -b $jar http://127.0.0.1:8080/api/topologies/latest
curl.exe -s -b $jar http://127.0.0.1:8080/api/topologies
curl.exe -s -b $jar http://127.0.0.1:8080/api/topologies/<graphId>

# ⑥ 取消 / 重新分析 / 自动学习策略
curl.exe -s -b $jar -X POST http://127.0.0.1:8080/api/topologies/learn/<sessionId>/cancel
curl.exe -s -b $jar -X POST http://127.0.0.1:8080/api/topologies/learn/<sessionId>/analyze
curl.exe -s -b $jar http://127.0.0.1:8080/api/topologies/policy
```

> 备选造数路径（T2 让 heartbeat 支持 `connectionWindows` 之后）：`POST /api/agents/<agentId>/heartbeat`
> body `{agentKey:"demo-agent-key-<agentId>", metrics:{}, connectionWindows:[...]}`，不需要登录 cookie，
> 该路由按 agentKey 鉴权，`agentKey` 见 `agents` 表（演示主机为 `demo-agent-key-<uuid>`）。

### 8.3 一键演示（推荐）

```powershell
docker compose exec -T control pnpm --filter @opsagent/control seed:topology
# 未加 package.json 脚本时等价命令：
docker compose exec -T control pnpm --filter @opsagent/control exec tsx scripts/seed-topology-demo.ts
```

**最终验收输出（2026-11-10 13:33，Lead 跑，120s 窗口 / 全部应用系统 / mock 大模型路径，EXIT=0）**：

```text
[learning] 会话 id=8fc1de1b-28c7-4e49-a90e-73c5bfc59229 windowSeconds=120 status=collecting → ready
[learning] 样本注入完成：804 行窗口边样本（13 台主机 × 12 个 10s 窗口）
[learning] 会话结束 status=ready model=topology-mock fallback=false
```

`GET /api/topologies/latest` 实测响应摘要（infra-qa 13:34 抓取，即页面当前展示的图）：

```json
{
  "id": "d0969a4c-bc78-4aaa-b521-1ae791ab0407",
  "sessionId": "8fc1de1b-28c7-4e49-a90e-73c5bfc59229",
  "version": 1,
  "window": { "start": "2026-11-10T05:31:47.033Z", "end": "2026-11-10T05:33:47.033Z", "seconds": 120 },
  "stats": {
    "nodeCount": 19, "edgeCount": 36, "hostCount": 13, "systemCount": 3, "externalCount": 6,
    "totalConnections": 28598, "failedConnections": 156, "samples": 804, "reportingAgents": 13
  },
  "analysis": { "model": "topology-mock", "confidence": 0.88, "insights": 3, "risks": 1 }
}
```

> 对照：infra-qa 在 13:18 独立跑通的那次（session `5598ecf3` / graph `6474c4a0 v7`，`model=llm`、
> failedConnections=184、edgeCount=36）是 T2 **in/out 计数口径修复前**的中间结果。
> 修复后 in 样本只补 `direction=both` 不重复计数，failedConnections 回到设计合计 **156**。
> 当前 36 条边（设计 37 条）的差异来自 mock 模型只返回了 36 条边、matcher 以模型结构为准；
> 纯启发式路径在修复后应得到 37 条（mock 已 disabled，新学习请求会走启发式，可选复跑确认）。

说明：`fallback` 字段在大模型成功路径下省略（契约里可选，只有兜底时写 true），
脚本用 `SEED_TOPO_EXPECT_FALLBACK=auto`（默认）根据 `model_providers` 是否有 active 模型决定期望：
无模型要求 `fallback=true`，有模型要求 `analysis.model` 非空且 `fallback≠true`；可用 `1/0` 强制。

### 8.4 启发式兜底路径记录（mock 接入前，用于对照）

Lead 在 mock server 接入前用 60s 窗口跑通过的日志：

```text
[learning] 已创建学习会话 id=da266b3d-... windowSeconds=60 status=collecting
[learning] 生成 13 台主机的窗口样本：每台 6 个窗口，共 37 条逻辑边
[learning] 样本注入完成：402 行窗口边样本
[learning] 会话结束 status=ready model=heuristic fallback=true
{ nodeCount: 19, edgeCount: 36, failedEdgeCount: 8, failedConnections: 200,
  insightCount: 8, riskCount: 3, fallback: true, confidence: 0.65 }
```

对应 `topology_graphs` 记录（当时库中可查，`fallback=t`、`model=heuristic`；后因 seed:dev 重置库已不在）：

```text
cf05360d-5396-4010-a4d4-80c351f85825 | version 1 | heuristic | fallback=t | nodes 19 | edges 36 | failed 200
c99b3a61-adf8-4b9f-929b-7a403cfe2b91 | version 2 | heuristic | fallback=t | nodes 19 | edges 36 | failed 200
```

说明：`failedConnections=200` 是**修复前** in/out 重复计数的结果（设计合计 156）；修复后应为 156。
启发式路径的洞察数量（8）与风险（3）比 mock 模型路径（3/1）更丰富，属模型差异，不是缺陷。
两种路径都要求 `nodeCount≥13`、`edgeCount≥30`、存在 failed>0 的异常边、insights≥3。

### 8.5 页验收记录（2026-11-10 13:56，最终图）

> 注意：web 容器里的 Vite 在宿主机文件更新后不会自动失效（§10.12），13:50 前 5173 一直在吐旧模块
> （所以早前看到「业务系统 4」、主机名截断）。**最终验收前执行了 `docker compose restart web`**，
> 之后页面即为最新代码，最终截图以重启后的为准。

- Playwright + 系统 Edge（设计工作台无头浏览器在本页会退出，见 §10.13）按 1680×1004 / 1440×900 打开
  `http://localhost:5173` → 侧栏「访问拓扑」（真实数据）与 `?demo=topology`（演示数据）都能渲染：
  - 页面标题「业务访问拓扑」，版本 v1 · 13:33 · 19 节点 / 36 链路；
  - 统计条：节点 19 / 链路 36 / 连接 28.6k / 失败连接 156 / **业务系统 3 · 外部依赖 6** / 窗口 2 分钟 /
    样本 0.8k · Agent 13；
  - 分层画布：接入层 3、应用层 5、中间件层 2、数据层 3、外部依赖 6，业务系统色带正常；
  - 节点卡片主机名完整显示（gateway-order-01 / prod-scheduler-01 / prod-mysql-pay-01），
    外部依赖节点服务标签显示 `tcp/443`；
  - 分析侧栏：模型徽标 **`topology-mock`**、置信度 88%、核心链路、风险与洞察（失败链路标红）；
  - **无 console error / pageerror**（仅登录前 `/api/me` 的预期 401）；API 200
    （`/api/topologies`、`/latest`、`/policy`、`/learn/active`）。
- Lead 13:56 用 Playwright + Edge 在 1680×1004 与 1440×900 复核：audit `issueCount=0`、无横向溢出、
  无 console error；最终图 `d0969a4c v1` 在页面上保持展示。
- 截图：`C:\Users\11490\AppData\Local\Temp\topology-navigate.png`（1680×1004 最新）、
  `topology-canvas.png`（2x 画布细节）；1440×900 同布局无溢出。
- 尾巴：图例里「外部依赖」作为外部节点分组名仍出现一次（与分层图例同名，删或改名均可），不影响验收。
- 模型 provider 在 13:50 置为 `disabled` 后，页面仍展示已生成的 `d0969a4c`（新学习请求才会走兜底）。

## 9. 验收清单与命令

按“功能就绪”的时间点执行，失败如实记录（不隐瞒、不跳过）：

```powershell
# 静态检查 / 构建（仓库根目录，Windows 本机）
pnpm typecheck          # pnpm -r typecheck（contracts / control / web）
pnpm build              # pnpm -r build（contracts 先出 dist，control tsc，web tsc+vite build）

# 单元测试
# 注意：根 pnpm test 目前会先跑不存在的 scripts/ensure-test-db.mjs（见 §10），
# 可先手动确认测试库存在，再直接跑递归测试：
docker compose exec -T postgres psql -U opsagent -d postgres -c "SELECT 1 FROM pg_database WHERE datname='opsagent_test'"
pnpm -r test            # 或 pnpm --filter @opsagent/control test / pnpm --filter @opsagent/web test

# Go Agent
cd agents/opsagent-agent
go build ./...
go vet ./...
go test ./...

# Playwright E2E（需要 web 5173 + control 8080；用已 seed 的本地库）
pnpm e2e

# 设计工作台（拓扑页）
# preview_page 打开 http://127.0.0.1:5173/topology 后：
# look_design 1680x1004 / 1440x900；check_design 查截断/重叠/对比度/脚本报错
```

验收口径（拓扑页）：`nodeCount≥13`、`edgeCount≥30`、存在 failed>0 的异常边、分析侧栏 ≥3 条洞察、
模型徽标与实际路径一致（有 active 模型显示大模型/置信度，无模型显示「规则引擎兜底」）、
空态/失败态可用、1440/1680 无严重视觉问题（截断/重叠/对比度）。

### 9.1 回归结果（2026-11-10 13:57 最终回归）

| 命令 | 结果 | 备注 |
| --- | --- | --- |
| `pnpm typecheck` | ✅ EXIT=0 | contracts / control / web 3/3 通过 |
| `pnpm build` | ✅ EXIT=0 | contracts tsc、control tsc、web `tsc && vite build` 通过；web 产物 818.76 kB（gzip 230.62 kB），有 >500kB 分包建议（非失败） |
| `pnpm -r test` | ✅ EXIT=0 | contracts 5/5、web 25 文件 50/50 通过（有 React `act(...)` 警告，不影响结果）、control 69 文件通过 + 1 跳过：**221 passed / 3 skipped**（含 `topology_learning.test.ts` 20 条、`topology_analyzer.test.ts` 15 条、`connection_edges.test.ts` 8 条） |
| `cd agents/opsagent-agent && go build ./... && go vet ./... && go test ./...` | ✅ 全 EXIT=0 | `ok github.com/opsagent/opsagent-agent 3.336s` |
| `pnpm e2e`（Playwright，自起 control:18080 + web:15173，测试库 opsagent_e2e） | ✅ **14 passed (39.9s) EXIT=0** | 已修 `all-pages.spec.ts` 的「no oversized SVG icons」断言：排除 `role="application"`/`role="img"` 的 svg 与拓扑画布/迷你地图容器，空态示意图 SVG 补 `role="img"`；其余 13 条（agent 安装、设计外壳、G1 会话/审批、登出、平台管理员、侧栏与聊天）全过。 |

## 10. 日志与已知问题（按重要性）

1. **模型配置现状（两条路径都已验证）**：mock server 接入前 `model_providers` 为 0 行，
   `ModelCompletionService.complete()` 抛 `model_not_configured`，拓扑分析走启发式兜底
   （`fallback=true`，见 §8.4）。验收期库里有一条 `本地拓扑分析 mock`（openai / `http://host.docker.internal:9099/v1` / model `topology-mock`），
   大模型路径已跑通（`model=topology-mock`，见 §8.3）；该 provider 已于 **13:50 置为 `disabled`**
   （避免 mock 停止后 45s 超时），之后的新学习请求会走启发式兜底（约 10s），已生成的最终图不变。
2. **`docker compose run --rm --no-build seed` 不可用**（compose v5 无 `--no-build`；去掉后旧 seed 镜像
   pnpm 自动 install 失败）→ 用 `docker compose exec -T control pnpm --filter @opsagent/control seed:*`。
3. **迁移不会随 control 启动自动执行，也不能整体重放**（§6）；新迁移用 `compose cp` + `psql -f` 单独执行。
4. **主机在线判定是 90 秒窗口**：`listAppSystems.onlineCount` 用 `last_seen >= now()-90s`；
   seed:demo 的 4 台主机 `last_seen` 是 12 分钟前 → API 显示 offline。拓扑演示脚本已把 13 台刷新为 `now()`；
   重跑 seed:demo 后需要再跑一次 seed-topology-demo 刷新。
5. **根 `pnpm test` 的说明已澄清**：根 `package.json` 的 `test` 是
   `pnpm --filter @opsagent/control exec node scripts/ensure-test-db.mjs && pnpm -r test`，
   `apps/control/scripts/ensure-test-db.mjs` **存在**（控制面包内路径），可直接运行；
   若 `opsagent_test` 已被其它测试并发 DROP SCHEMA，用 `TEST_DATABASE_URL=..._learning` 隔离。
6. **orphan 容器告警**：`opsagent-os-agent`（node:22-alpine，已退出）不属于当前 compose 服务，
   每次 `docker compose up` 会警告 `Found orphan containers`。无害，**不要**随手 `--remove-orphans`。
7. **`.env` 的 `OPSAGENT_PUBLIC_URL=http://10.79.4.206:8080`** 是宿主机局域网 IP，不是 127.0.0.1；
   agent 安装包/回调地址会用它。本机 curl 仍用 `127.0.0.1:8080`。
8. Web 容器 tail 日志里可能出现旧的 `exit code 143`（3 天前旧运行被 SIGTERM），当前运行 restartCount=0，
   `curl http://127.0.0.1:5173/` 返回 200 即可忽略。
9. **（已修复）`POST /api/topologies/learn` 的 42P08**：早期版本 INSERT 里 `$4` 同时用于 integer 列
   `window_seconds` 和 `make_interval(secs => $4)`（double precision），报
   `inconsistent types deduced for parameter $4`。Lead 已用 `$4::integer` 修复并重启 control；
   13:18 起创建会话正常（201）。只读接口：`GET /api/topologies` → `{"graphs":[...]}`、
   `GET /api/topologies/latest` → 图对象或 JSON `null`（无图时 200 + null，前端渲染空态）、
   `GET /api/topologies/learn/active` → 会话或 null、`GET /api/topologies/policy` → 策略对象。
10. **typecheck 现状（13:24）**：`pnpm typecheck` 3/3 通过（contracts / control / web，含 T4 topology.tsx）。
    13:12 时的 web 报错（`Cannot find module './routes/topology.js'`）是 T4 未落地时的中间态，已消失。
11. **拓扑页显示缺陷（13:20 发现，13:52 复验，web 最后一轮已修）**：
    a) **模型徽标（已修复）**：13:20 时 API 返回 `analysis.model="llm"` 且无 `fallback`，web 把 `llm`
       当兜底，显示「大模型不可用 · 规则引擎兜底」；13:33 后 T3 已传真实模型名 `topology-mock`，
       页面徽标与侧栏均显示 `topology-mock`，矛盾消失。
    b) **已修复**：节点卡片主机名不再截断（`gateway-order-01` / `prod-scheduler-01` / `prod-mysql-pay-01` 完整）。
    c) **已修复**：外部依赖节点服务标签显示 `tcp/443`（不再是 `port 443:443`）。
    d) **已修复**：统计条现在显示「业务系统 3 · 外部依赖 6」。仅图例里「外部依赖」仍作为外部节点分组名
       与分层图例同名各出现一次（去重改名即可，不影响验收）。
12. **web 容器 Vite 不会热更新宿主机改动（已踩坑）**：Windows→Docker bind mount 下 inotify 不生效，
    `apps/web/vite.config.ts` 没有配 `server.watch.usePolling`。web 源码在宿主机改动后，容器里的 Vite
    仍可能持续返回旧模块（实测：nav.ts 磁盘 1802 字节含「访问拓扑」，服务端返回 5239 字节的旧版本，
    导致侧栏看不到新入口；13:47 web 修完后 5173 仍显示旧的「业务系统 4」/截断主机名）。
    **每次需要在 5173 上看最新代码前都要 `docker compose restart web`**（vite 0.3s 起），
    最终验收截图已按此执行（§8.5）。建议 web owner 在 vite.config.ts 加
    `server: { watch: { usePolling: true, interval: 300 } }`，否则 HMR 不可信。
13. **设计工作台的无头浏览器在拓扑页会退出**：`preview_page` 能打开，但 `look_design`/`check_design`
    返回 `browser exited`（1680×1004 与 1440×900 都复现；`/?demo=topology` 与 `/topology` 同样）。
    已改用 Playwright + 系统 Edge 截图核验（见 §8.5）。疑似该页 SVG/动画负载触发工作台浏览器崩溃，
    需要 web owner 或工具侧跟进；在此之前拓扑页的自动化量测走 Playwright。
14. **T2 聚合口径（已修复）**：早期 `buildLearningInput` 把 in/out 双向观测计数相加
    （`direction=both` 的边 opened/failed 翻倍，启发式那轮 failedConnections=200，而设计合计是 156），
    且 `outByPeerPort` 用单值覆盖，同主机两个服务访问同一目标端口会丢边。
    T2 已改为「计数以 out 为准，in 只补 direction=both（不计数）」+ `outByPeerPort` 存候选数组；
    最终验收图 `failedConnections=156` 与设计合计一致，口径修正确认。
    剩余差异：大模型路径 `edgeCount=36`（设计 37），因为 mock 模型只返回 36 条边、matcher 以模型结构为准；
    纯启发式路径修复后应得到 37 条（mock 已 disabled，新学习请求会走启发式，可选复跑确认；不阻塞演示阈值 30+）。

## 11. 待办 / 依赖

- [x] 端到端跑通（120s 窗口 + mock 大模型路径，最终会话 `8fc1de1b` / 图 `d0969a4c`，19/36/156），
  见 §8.3；启发式对照见 §8.4。
- [x] T2 聚合口径修复（§10.14）：in 不再重复计数（failed 156 与设计一致）；`outByPeerPort` 改候选数组。
- [x] T3/Web 模型徽标修复（§10.11a）：页面显示 `topology-mock`，不再是「大模型不可用」。
- [x] 纯启发式路径已有证据（§8.4）；mock provider 已于 13:50 `disabled`，之后新学习请求天然走启发式
  （约 10s），如需最终图可再跑一次 `seed:topology`（可选，预期 `edgeCount=37`）。
- [x] Web 小瑕疵（§10.11b/c/d）：主机名截断、外部节点 `port 443:443`、业务系统数 4 均已修；仅图例还重复出现一次「外部依赖」。
- [ ] 设计工作台无头浏览器在拓扑页退出（§10.13）→ 需要工具侧/web owner 跟进；暂用 Playwright 截图验收。
- [ ] Web Vite 热更新（§10.12）→ 建议加 `server.watch.usePolling`，否则每次改完需重启 web 容器。
- [x] `seed:topology` 已在 `apps/control/package.json`（Lead 已加，实测命令可用）。
- [x] 根 `pnpm test` 已改为 `pnpm --filter @opsagent/control exec node scripts/ensure-test-db.mjs && pnpm -r test`，
  `apps/control/scripts/ensure-test-db.mjs` 已存在。
- [x] 最终回归：`pnpm typecheck`（✅ 3/3）、`pnpm build`（✅）、`pnpm -r test`（✅ contracts 5/5、web 50/50、control 221 passed/3 skipped）、
  `go build/vet/test`（✅）、`pnpm e2e`（✅ **14 passed / 39.9s / EXIT=0**，见 §9.1）。
  e2e 的「超大 SVG 图标」断言已修：排除 `role="application"`/`role="img"` 的画布与迷你地图，空态示意图 SVG 补 role，
  不再误伤拓扑页。

## 12. 拓扑 V2 验证（2026-11-10 18:30，按用户 6 条反馈迭代）

需求映射：① 未归属主机默认隐藏（开关可选）；② 改为平台浅色风格；③ 缩放 30%~300% + 节点详情；
④ 大模型基于监听端口/进程命令行/建连证据识别组件（product/role/systemService）；⑤ IT 架构 6 层
（接入/应用/中间件/数据/运维观测/外部）；⑥ 按业务系统横向泳道排列，替换原竖向堆叠。

- 后端：`topology-v2`；分层 `access|app|middleware|data|ops|external`；节点带 product/role/systemService；
  prompt 预算 ≤45k 字符（适配 32k/64k 上下文）；规则引擎兜底同口径。
- 数据验证：插入 1 台未归属测试机 `unassigned-demo-01` 后学习，最终图 `hostCount=13`、
  `stats.excludedUnassigned=1`、节点中无该主机；示例分类：`prod-cache-01`→middleware/cache/Redis/缓存、
  `prod-kafka-01`→middleware/mq/Kafka/消息队列、`prod-mysql-01`→data/database/MySQL/关系型数据库、
  `prod-monitor-01`→ops/monitoring/Prometheus/监控/systemService=true、`prod-web-01`→app/
  「order-service / Nginx」/业务应用（含接入代理）。
- 最终图：v3，20 节点 / 36 条访问关系 / 失败 156 / 3 业务系统 / 外部依赖 6；`analysis.model=topology-mock`、
  `promptVersion=topology-v2`（mock 验证大模型链路；provider 验证后 disabled，新学习走启发式兜底）。
- 页面：平台浅色 tokens + 业务系统横向泳道 + 6 分层列；默认 fit（1680 下 79%、1440 下 62%），
  缩放 30%~300%，节点详情展示大模型识别结果（product/role/type）；Playwright audit
  issueCount=0、无横向溢出、无 console error（仅登录前 `/api/me` 预期 401）。
- 门禁：`pnpm -r typecheck` ✅、`pnpm build` ✅、`pnpm -r test` ✅（control 233 passed/3 skipped）、
  `pnpm e2e` ✅ 14 passed；Go 测试未受本轮影响（Agent 版本 0.6.3）。

## 13. 拓扑 V3 可读性重构（2026-11-10 21:00，按内网实测截图反馈）

用户内网实测：1 个业务系统 / 4 台主机 / 22 个外部 IP / 72 条原始边，截图表现为边标签满屏重叠、
外部节点一字长蛇、主机卡服务 chips 过密、无全屏、无法聚焦看关系。V3 针对「清晰直观 + 全屏 + 节点详情/关联」重构：

- 边：按 source→target 聚合（真实 v3 图原始 36 → 默认 28 条；dense 场景 72 → 15 条），标签只在悬停/选中显示；
  默认过滤管理流量（SSH/Zabbix/Node Exporter/Prometheus/Grafana/Agent 自身）与低流量边，可在「显示设置」恢复。
- 外部依赖：按 IP 聚合 + topN（默认 8）+「其他外部依赖」节点；聚合节点详情列出全部外部 IP/端口/连接数；
  dense 场景 22 个外部 IP → 9 组卡片。
- 节点卡：紧凑显示主机名 + product/role + 主端口（≤2）+「N 项服务」；业务服务与系统管理服务在详情分开，
  不再堆 `sshd:22 +13` 之类 chips；泳道高度按单元最大行数自适应。
- 交互：**全屏模式**（覆盖式，Esc 退出；1920×1080 验证）；**点击节点进入聚焦态**，右侧详情展示组件识别、
  指标、业务/管理服务、**入站/出站关联节点列表**（可点击切换聚焦）；支持返回全图/保持全图/全屏查看；
  缩放 30%~300%（滚轮/按钮/1:1/适应/全图），minimap 默认不遮挡、≥150% 自动隐藏。
- 数据清洗：控制面聚合过滤 Agent 自身 `opsagent-agent` 管理流量；`stats.externalCount` 改为唯一外部 IP 数。
- 验证：真实 v3 图 1582×1089/1680/1920 全屏 + dense 场景（4 主机/22 外部 IP/72 边）截图；
  Playwright audit issueCount=0、无横向溢出、无 console error；`pnpm -r typecheck` ✅、`pnpm build` ✅、
  `pnpm -r test` ✅（control **235 passed / 3 skipped**）、`pnpm e2e` ✅ 14 passed。


