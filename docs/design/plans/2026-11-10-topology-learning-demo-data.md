# 访问拓扑演示数据集：3 业务系统 / 13 主机 / 37 条建连边

> 状态：方案已批准并落地脚本（2026-11-10）
>
> 脚本：`apps/control/scripts/seed-topology-demo.ts`（package.json 的 `seed:topology` 由 Lead 添加）
>
> 关联设计：`docs/design/plans/2026-11-10-topology-learning.md`（总体方案）、
> `docs/design/plans/2026-11-10-topology-learning-infra.md`（环境与验收手册）

## 1. 目标与验收口径

演示数据要能支撑一张「一眼看懂业务访问关系」的拓扑图，端到端走**真实聚合 + 分析管线**，不直接插拓扑图：

| 验收项 | 阈值 |
| --- | --- |
| 主机节点 `nodeCount` | ≥ 13（外加 6 个外部依赖节点） |
| 逻辑边 `edgeCount` | ≥ 30（设计 37 条） |
| 异常链路 | 至少 1 条 `failed > 0` 的边，且失败集中在 2 条链路上 |
| 分析结论 | `analysis.insights` ≥ 3 条；`analysis.fallback === true`（当前无模型配置） |
| 业务系统 | 3 个：订单中心 / 支付网关 / 基础运行平台 |

数据规模：13 台主机、约 24 个关键进程、22 个监听端口、37 条逻辑边、6 个外部依赖。
注入数据库后每个学习窗口约 **67 行** `agent_connection_edges`（37 条 out + 30 条 in）。

## 2. 业务系统

| 应用系统 | code | 负责人 | 等级 | 主机数 | 网段 |
| --- | --- | --- | --- | --- | --- |
| 订单中心 | order-center | 交易研发组 | P1 | 5 | 10.20.8.0/24 |
| 支付网关 | payment-gateway | 支付研发组 | P1 | 6 | 10.20.9.0/24 |
| 基础运行平台 | platform-runtime | 基础架构组 | P2 | 2 | 10.20.9.0/24、10.20.10.0/24 |

> 应用系统 ID 沿用 `seed-demo.ts`：`f0000000-0000-4000-8000-00000000000{1,2,3}`。

## 3. 主机清单（13 台）

| # | 主机 | IP | 业务系统 | 角色层 | 监听端口 / 服务 | 关键进程（pid） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | gateway-order-01 | 10.20.8.11 | 订单中心 | ingress | 80/tcp nginx、443/tcp nginx | nginx(1180)、keepalived(1105) |
| 2 | prod-web-01 | 10.20.8.12 | 订单中心 | ingress/app | 80、443 nginx；8080 order-service | nginx(1180)、java order-service(4123) |
| 3 | prod-order-12 | 10.20.8.34 | 订单中心 | app | 8080 order-service | java order-service(5140)、java order-worker(5301) |
| 4 | prod-order-13 | 10.20.8.35 | 订单中心 | app | 8080 order-service | java order-service(6032)、java order-worker(6210) |
| 5 | prod-mysql-01 | 10.20.8.61 | 订单中心 | data | 3306 mysqld、9100 node_exporter | mysqld(2310)、node_exporter(2450) |
| 6 | gateway-pay-01 | 10.20.9.11 | 支付网关 | ingress | 443、8443 nginx | nginx(1210)、keepalived(1120) |
| 7 | prod-pay-01 | 10.20.9.12 | 支付网关 | app | 8080 payment-service | java payment-service(7102)、java payment-worker(7260) |
| 8 | prod-pay-02 | 10.20.9.13 | 支付网关 | app | 8080 payment-service | java payment-service(8102) |
| 9 | prod-mysql-pay-01 | 10.20.9.61 | 支付网关 | data | 3306 mysqld、9100 node_exporter | mysqld(2610)、node_exporter(2700) |
| 10 | prod-cache-01 | 10.20.9.45 | 支付网关 | middleware | 6379 redis、10050 zabbix-agent2 | redis-server(1910)、zabbix_agent2(2010) |
| 11 | prod-kafka-01 | 10.20.9.31 | 支付网关 | middleware | 9092 kafka | java kafka(3102) |
| 12 | prod-db-01 | 10.20.9.21 | 基础运行平台 | data | 5432 postgresql、9100 node_exporter | postgres(2810)、node_exporter(2900) |
| 13 | prod-scheduler-01 | 10.20.10.21 | 基础运行平台 | app/monitor | 8090 scheduler、9090 prometheus | java scheduler(9001)、prometheus(9010) |

主机 ID：沿用 4 台老主机 `b0000000-...-000{1,2,3,4}`，新增 9 台
`b0000000-...-0005..000d`（见脚本 `HOSTS` 常量）。

## 4. 建连边清单（37 条逻辑边，窗口合计口径）

> `opened/closed/failed/active` 是整个学习窗口（默认 120s）的合计值；`active` 是并发连接数，
> 注入时只放在最后一个 10s 窗口，避免窗口求和放大。
> direction：源主机 `out` + 受管目标主机 `in`（用于验证双向去重）；外部依赖只有 `out`。

| # | 源（进程 pid） | 目标:端口 | 类型 | opened | failed | active |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | gateway-order-01 nginx(1180) | prod-web-01:443 | 接入→应用 | 5200 | 0 | 120 |
| 2 | gateway-order-01 nginx(1180) | prod-web-01:80 | 接入→应用 | 1800 | 0 | 40 |
| 3 | gateway-order-01 nginx(1180) | prod-order-12:8080 | 接入→应用 | 2600 | 0 | 90 |
| 4 | gateway-order-01 nginx(1180) | prod-order-13:8080 | 接入→应用 | 2450 | 0 | 85 |
| 5 | gateway-pay-01 nginx(1210) | prod-pay-01:8080 | 接入→应用 | 3100 | 0 | 110 |
| 6 | gateway-pay-01 nginx(1210) | prod-pay-02:8080 | 接入→应用 | 3050 | 0 | 105 |
| 7 | prod-web-01 order-service(4123) | prod-pay-01:8080 | 跨系统 | 900 | 0 | 30 |
| 8 | prod-order-12 order-service(5140) | prod-pay-01:8080 | 跨系统 | 640 | 0 | 24 |
| 9 | prod-order-12 order-worker(5301) | prod-pay-02:8080 | 跨系统 | 520 | 0 | 18 |
| 10 | prod-order-13 order-service(6032) | prod-pay-02:8080 | 跨系统 | 580 | 0 | 20 |
| 11 | prod-pay-01 payment-service(7102) | prod-order-12:8080 | 跨系统 | 310 | 0 | 12 |
| 12 | prod-scheduler-01 scheduler(9001) | prod-order-13:8080 | 跨系统 | 120 | 0 | 6 |
| 13 | prod-scheduler-01 scheduler(9001) | prod-pay-01:8080 | 跨系统 | 110 | 0 | 6 |
| 14 | prod-web-01 order-service(4123) | prod-mysql-01:3306 | 数据 | 180 | 2 | 40 |
| 15 | prod-order-12 order-service(5140) | prod-mysql-01:3306 | 数据 | 220 | 0 | 50 |
| 16 | prod-order-12 order-worker(5301) | prod-mysql-01:3306 | 数据 | 90 | 0 | 16 |
| 17 | ★ prod-order-13 order-service(6032) | prod-mysql-01:3306 | 数据（异常） | 210 | **42** | 35 |
| 18 | prod-pay-01 payment-service(7102) | prod-mysql-pay-01:3306 | 数据 | 160 | 0 | 38 |
| 19 | prod-pay-02 payment-service(8102) | prod-mysql-pay-01:3306 | 数据 | 150 | 0 | 36 |
| 20 | prod-web-01 order-service(4123) | prod-cache-01:6379 | 缓存 | 780 | 0 | 60 |
| 21 | prod-order-12 order-worker(5301) | prod-cache-01:6379 | 缓存 | 610 | 0 | 45 |
| 22 | prod-pay-01 payment-service(7102) | prod-cache-01:6379 | 缓存 | 940 | 0 | 72 |
| 23 | prod-pay-01 payment-service(7102) | prod-kafka-01:9092 | 消息 | 260 | 0 | 25 |
| 24 | prod-order-12 order-worker(5301) | prod-kafka-01:9092 | 消息 | 180 | 0 | 18 |
| 25 | prod-scheduler-01 scheduler(9001) | prod-db-01:5432 | 数据 | 60 | 0 | 10 |
| 26 | prod-pay-02 payment-service(8102) | prod-db-01:5432 | 数据 | 45 | 0 | 8 |
| 27 | ★ prod-pay-01 payment-service(7102) | 110.75.32.18:443 支付宝 | 外部（异常） | 240 | **96** | 3 |
| 28 | prod-pay-02 payment-service(8102) | 121.51.130.5:443 微信支付 | 外部 | 180 | 6 | 2 |
| 29 | prod-pay-01 payment-service(7102) | 202.101.25.8:443 银联 | 外部 | 65 | 1 | 1 |
| 30 | prod-web-01 order-service(4123) | 47.96.133.21:443 短信 | 外部 | 95 | 2 | 1 |
| 31 | prod-order-13 order-service(6032) | 203.119.128.7:443 风控 | 外部 | 140 | 4 | 2 |
| 32 | prod-order-12 order-service(5140) | 203.119.128.7:443 风控 | 外部 | 130 | 3 | 2 |
| 33 | prod-scheduler-01 scheduler(9001) | 47.98.203.9:443 对象存储 | 外部 | 20 | 0 | 1 |
| 34 | prod-scheduler-01 prometheus(9010) | prod-mysql-01:9100 | 监控 | 60 | 0 | 1 |
| 35 | prod-scheduler-01 prometheus(9010) | prod-db-01:9100 | 监控 | 60 | 0 | 1 |
| 36 | prod-scheduler-01 prometheus(9010) | prod-mysql-pay-01:9100 | 监控 | 60 | 0 | 1 |
| 37 | prod-web-01 nginx(1180) | prod-order-12:8080 | upstream | 1200 | 0 | 55 |

覆盖度检查：接入→应用 6 条、跨业务系统 7 条、应用→MySQL 6 条、→Redis 3 条、→Kafka 2 条、
→PostgreSQL 2 条、→外部第三方 7 条、监控/upstream 4 条；异常链路 2 条（#17 MySQL 20% 失败、#27 支付宝 40% 失败）。

## 5. 外部依赖

| key | IP | 名称 | 备注 |
| --- | --- | --- | --- |
| alipay | 110.75.32.18 | 支付宝支付网关 | 第三方支付渠道（40% 失败，critical） |
| wechatPay | 121.51.130.5 | 微信支付网关 | 第三方支付渠道 |
| unionPay | 202.101.25.8 | 银联支付网关 | 第三方支付渠道 |
| sms | 47.96.133.21 | 短信服务商 | 第三方通知服务 |
| riskApi | 203.119.128.7 | 风控 API | 外部风控服务 |
| oss | 47.98.203.9 | 对象存储 CDN | 外部存储依赖 |

## 6. 落地方式：`seed-topology-demo.ts`

### 6.1 两阶段

1. **数据库阶段（幂等）**
   - upsert 3 个 `app_systems`（`ON CONFLICT (id) DO UPDATE`）。
   - upsert 13 个 `agents`：`status='online'`、`last_seen=now()`、`discovery_at=now()`，
     `system_info.ip` 用上表 IP（另有 `ipAddresses`、`listeningPorts`），
     `applications` 按监听端口生成，`agent_info`/`metrics` 复用 `seed-demo.ts` 形状。
   - 重建 `agent_inventory`：先删本批演示主机的旧 inventory，再写入
     - `kind='port'`：每个监听端口两行 `0.0.0.0:<port>` 与 `<主机IP>:<port>`，
       `detail={address, port, process, pid, service, protocol:'tcp', command}`；
     - `kind='process'`：`name='<进程名>'`，`detail={name, pid, command, user}`。
     聚合端从 port 行按 `:port` 解析端口，并取 `detail.service` / `detail.process` 作为目标服务名。
2. **学习阶段（真实管线）**
   - `POST /api/auth/local-admin` 登录取 `opsagent_session` cookie；
   - `GET /api/topologies/learn/active`：有进行中的会话就复用（幂等；`SEED_TOPO_FORCE_NEW_SESSION=1` 可强制新建），否则
     `POST /api/topologies/learn {"windowSeconds":120}`；
   - 每台主机生成 12 个 10s 窗口，逐个
     `POST /api/topologies/learn/:id/samples {"agentId":"...","windows":[...]}`；
   - 轮询 `GET /api/topologies/learn/:id` 直到 `ready`（上限 `window+90s`）；
   - `GET /api/topologies/latest` 校验：nodeCount≥13、edgeCount≥30、存在 failed>0 的边、
     insights≥3、`analysis.fallback===true`；不满足打印 JSON 摘要并以非 0 退出。
   - 学习阶段结束（成功或失败）都会**刷新 13 台主机的 `last_seen`**：主机在线判定是
     `last_seen >= now()-90s`，不刷新的话 seed 后 90s 页面上的在线数会掉到 0。

### 6.2 计数在窗口上的分摊

- `opened/closed/failed`：12 个窗口均摊，余数从中间窗口补 1，保证**窗口合计精确等于上表**。
- `active`：并发快照，**只放最后一个窗口**，其余窗口为 0；无论聚合端求和还是取最大值都不会被放大 12 倍。
- `firstSeen/lastSeen`：窗口起止；`container=''`、`baseline=false`。
- 端口约定：out 行 `localPort = 41000 + edgeIndex`，in 行 `peerPort = 40000 + edgeIndex`，
  保证唯一键 `(tenant_id, agent_id, window_start, direction, process, pid, local_address, local_port, peer_address, peer_port)` 不冲突。

### 6.3 samples API payload 示例（简化一条边）

```json
{
  "agentId": "b0000000-0000-4000-8000-000000000002",
  "windows": [
    {
      "start": "2026-11-10T05:01:00.000Z",
      "end": "2026-11-10T05:01:10.000Z",
      "source": "procfs",
      "edges": [
        {
          "direction": "out",
          "process": "java",
          "pid": 5140,
          "service": "order-service",
          "command": "java -Xms4g -Xmx8g -jar /opt/order/order-service.jar",
          "localAddress": "10.20.8.34",
          "localPort": 41007,
          "peerAddress": "10.20.9.12",
          "peerPort": 8080,
          "protocol": "tcp",
          "opened": 53,
          "closed": 51,
          "failed": 0,
          "active": 0,
          "baseline": false,
          "container": "",
          "firstSeen": "2026-11-10T05:01:00.000Z",
          "lastSeen": "2026-11-10T05:01:10.000Z"
        }
      ],
      "stats": { "scans": 2, "activeConnections": 0, "dropped": 0 }
    }
  ]
}
```

> 实际脚本一次给 12 个窗口，每个主机的窗口里只含该主机作为源（out）或目标（in）的边。

## 7. 备用 SQL 草稿（学习 API 未就绪时直插窗口样本）

> 只在本地联调/排障用。样本的 `window_start/window_end` 必须落在进行中的学习会话
> `started_at..ends_at` 之内，否则聚合看不到。先创建会话拿到时间窗（`POST /api/topologies/learn`
> 后从响应取 `startedAt/endsAt`），或手工插一条
> `topology_learning_sessions`（`status='collecting'`、`ends_at > now()`）。

```sql
-- 会话与 tenant 变量（psql 用 \set，或把 :xxx 替换成实际值）
-- \set tenant '00000000-0000-4000-8000-000000000001'
-- \set session_start '2026-11-10T05:01:00Z'
-- \set session_end   '2026-11-10T05:03:00Z'

-- 示例：prod-order-12 → prod-pay-01:8080 的 out 行 + prod-pay-01 的 in 行
INSERT INTO agent_connection_edges (
  tenant_id, agent_id, window_start, window_end, source, direction,
  process, pid, service, command,
  local_address, local_port, peer_address, peer_port, protocol,
  opened, closed, failed, active, container, baseline, first_seen, last_seen
) VALUES
  (:'tenant', 'b0000000-0000-4000-8000-000000000002',
   :'session_start', :'session_start'::timestamptz + interval '10 seconds', 'procfs', 'out',
   'java', 5140, 'order-service',
   'java -Xms4g -Xmx8g -jar /opt/order/order-service.jar',
   '10.20.8.34', 41007, '10.20.9.12', 8080, 'tcp',
   53, 51, 0, 24, '', false, :'session_start', :'session_start'::timestamptz + interval '10 seconds'),
  (:'tenant', 'b0000000-0000-4000-8000-000000000009',
   :'session_start', :'session_start'::timestamptz + interval '10 seconds', 'procfs', 'in',
   'java', 7102, 'payment-service',
   'java -Xms2g -Xmx4g -jar /opt/pay/payment-service.jar',
   '10.20.9.12', 8080, '10.20.8.34', 40007, 'tcp',
   53, 51, 0, 24, '', false, :'session_start', :'session_start'::timestamptz + interval '10 seconds')
ON CONFLICT (tenant_id, agent_id, window_start, direction, process, pid,
             local_address, local_port, peer_address, peer_port)
DO UPDATE SET
  opened = EXCLUDED.opened, closed = EXCLUDED.closed, failed = EXCLUDED.failed,
  active = EXCLUDED.active, last_seen = EXCLUDED.last_seen, received_at = now();

-- 全量入库后的抽样校验（应与脚本口径一致：out≈37 行、in≈30 行）
SELECT direction, count(*) AS rows, sum(opened) AS opened, sum(failed) AS failed
FROM agent_connection_edges
WHERE tenant_id = :'tenant'
GROUP BY direction;

-- 失败链路校验：应看到 prod-order-13→prod-mysql-01 的 failed=42、
-- prod-pay-01→110.75.32.18:443 的 failed=96
SELECT peer_address, peer_port, process, direction, sum(opened) AS opened, sum(failed) AS failed
FROM agent_connection_edges
WHERE tenant_id = :'tenant'
GROUP BY peer_address, peer_port, process, direction
HAVING sum(failed) > 0
ORDER BY failed DESC;
```

> 37 条边的完整生成逻辑以脚本 `EDGES` 常量为准（`buildReports()` 自动补 out/in 行并分摊到 12 个窗口），
> 手工 SQL 只建议用于 1~2 条边的快速验证。

## 8. 实际分析输出（2026-11-10 实测）

无模型时的启发式兜底与 mock 大模型两条路径都已跑通。**最终验收**（13:33，120s，全部应用系统）：

| 路径 | 会话/图 | nodeCount | edgeCount | failedConnections | insights | risks | confidence | fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mock 大模型（120s，最终验收） | 8fc1de1b / d0969a4c v1 | 19 | 36 | 156 | 3 | 1 | 0.88 | 省略（false） |
| mock 大模型（120s，计数口径修复前） | 5598ecf3 / 6474c4a0 v7 | 19 | 36 | 184 | 3 | 1 | 0.88 | 省略（false） |
| 启发式（60s，mock 接入前，计数口径修复前） | da266b3d / v1~v3 | 19 | 36 | 200 | 8 | 3 | 0.65 | true |

- 计数口径修复后 `failedConnections=156`，与设计合计一致（外部 112 + prod-web-01→mysql 2 + prod-order-13→mysql 42），
  说明 T2 已改为「计数以 out 为准、in 只补 direction=both」。
- `edgeCount=36`（设计 37）：大模型路径由 mock 模型返回的边结构决定，mock 只给了 36 条边；
  纯启发式路径修复后应得到 37 条（待停用模型后复跑确认，不影响演示阈值 30+）。
- 页面模型徽标：13:20 曾因 `analysis.model="llm"` 占位显示「大模型不可用」，13:33 后 T3 传真实模型名
  `topology-mock`，页面显示正确（见 infra 文档 §10.11a）。
- 期望的「修复后」数值：`edgeCount=37`（启发式）；`failedConnections=156`（已达成）。

## 9. 运行与验证

```powershell
# 1) 静态数据（幂等，可重复执行）
docker compose exec -T control pnpm --filter @opsagent/control exec tsx scripts/seed-topology-demo.ts

# 等价命令（Lead 加好 package.json 脚本后）
docker compose exec -T control pnpm --filter @opsagent/control seed:topology

# 2) 只灌主机不跑学习（学习 API 未就绪时自测）
docker compose exec -T -e SEED_TOPO_SKIP_LEARNING=1 control pnpm --filter @opsagent/control exec tsx scripts/seed-topology-demo.ts
```

已在本地验证数据库阶段：输出 `agents: 13, appSystems: 3, inventory: 65`；学习阶段已于 2026-11-10 13:18 / 13:33
两次跑通（见 infra 文档 §8.3），`seed:topology` 默认走真实 HTTP 管线并在失败时非 0 退出。

## 10. 风险与对齐点

1. **out/in 去重口径**：T2 聚合需按 `(fromAgent, fromService, toAgent|peerIp, toPort)` 合并，且计数取
   `max(out,in)` 或只取 out；若实现为求和，演示数字会翻倍（不影响验收阈值，但页面观感偏大）。
   已在 `agent_connection_edges` 双向都写入，便于验证去重。
2. **`active` 聚合口径**：脚本只在最后一个窗口写 `active`；若聚合按窗口累加得到正确值，取 max 也正确。
3. **inventory 同名进程折叠**：`agent_inventory` 唯一键是 `(tenant, agent, kind, name)`，同主机两个 `java`
   进程（order-service / order-worker）只能保留一条 process 行；目标服务名仍由 port 行 `detail.service`
   精确区分，因此不影响拓扑服务命名。
4. **时间窗对齐**：样本时间必须落在会话窗口内；脚本用会话 `startedAt` 生成窗口，复用时也按原 `startedAt`。
5. **RLS**：脚本用 `DATABASE_URL` 的 `opsagent`（超级用户）连接，绕过 RLS；不要用非超级用户跑 seed。
6. **主机唯一键**：`agents` 有 `(tenant_id, hostname)` 唯一约束，脚本固定 ID + hostname，重复执行安全；
   若有人手工建过同名主机会冲突，需要先清理。
7. **实测差异（T2 聚合口径，已修复）**：
   - 修复前：设计 37 条逻辑边聚合结果 36 条（`outByPeerPort` 单值覆盖，同主机 order-service/order-worker
     到同一目标端口会丢边），且 `direction=both` 会把 out/in 计数相加（failed 200 vs 设计 156）。
   - 修复后（13:33 起）：in 样本只补 `direction=both` 不计数、`outByPeerPort` 存候选数组 → 最终验收
     `failedConnections=156` 与设计一致；`edgeCount` 仍为 36，但这是 mock 模型只返回 36 条边、matcher
     以模型结构为准导致，不是聚合丢边。纯启发式路径修复后应得到 37 条（待停用模型复跑确认）。
   - 影响：演示满足 `edgeCount≥30`、`failedEdgeCount=8`、`failedConnections=156` 的验收阈值。
8. **历史会话样本会保留**：每轮 `seed:topology` 注入 804 行；多次运行后 `agent_connection_edges` 会累积
   （按不同会话的时间窗），聚合按会话窗口过滤所以不影响结果，但排障时注意 `where window_start between ...`。
   如需干净演示，可先 `seed:dev` + `seed:demo` 再跑一次 `seed:topology`。
