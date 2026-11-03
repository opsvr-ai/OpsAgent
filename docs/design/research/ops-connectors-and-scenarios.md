# 运维智能体平台：标准连接器规范与场景库

> v0.1 ｜ 多租户运维智能体平台的接入层与场景层设计输入。结论先行；接口路径按厂商官方文档口径书写，出处见第 9 节。

---

## 0. 结论先行

1. **8 种标准连接器类型 + 1 个通用 HTTP 连接器，覆盖约 80% 运维平台**：观察类（Zabbix/Prometheus/Grafana/Loki/ES）、容器（K8s）、主机（SSH/WinRM）、自动化（AWX）、ITSM/CMDB（ServiceNow/NetBox）、云（CloudWatch/Azure）。剩余 20% 是商业 APM、国产一体化平台、私有 SOAP/gRPC 网管，交给通用 HTTP 连接器再兜底到 AI 生成插件。
2. **分三批落地**：P0 = Zabbix、Prometheus、Alertmanager、Grafana、Loki、Kubernetes、SSH、AWX（挡住 70% PoC）；P1 = ES/OpenSearch、VictoriaMetrics、ServiceNow、NetBox、CloudWatch/Azure；P2 = Docker、vCenter、SNMP、RESTCONF、Jira/PagerDuty。
3. **通用 HTTP 连接器投入产出比最高**：`请求模板 + JSONPath 子集映射 + 分页断言` 零代码接住大量 REST/JSON-RPC 平台，能再吃掉长尾的一半；需要多步签名、聚合计算、二进制协议的一律转 custom。
4. **写操作必须分级**：R0 只读自动执行；R1 低危写默认执行但全量审计；R2 高危写强制审批（生产双人）；R3（任意 shell、批量删除、改权限/计费）默认禁用，白名单 + 双人审批才可开。
5. **工具契约统一信封**：输入输出走 `data/meta/audit/render/error`；写操作必带 `idempotencyKey` 与 `dryRun`；审计含租户、执行者、审批单号、`credentialRef`（永不含明文）。
6. **场景库先做 9 个**，巡检、告警根因、日志排查是 P0 三件套（只读为主、无审批摩擦、价值可量化）；场景以参数化插件交付，不写死连接器。
7. **场景分享默认"租户内角色组可用"**；进平台市场须创建者申请、租户管理员审批、平台安全扫描，状态机 8 态，审批后**只能收窄权限**。
8. **非标平台走创造模式 8 步**：描述 → AI 探查 → 生成草稿 → 沙箱测试 → 人工双审 → 灰度 → 观察 → 转正。硬约束：网络白名单、只读优先、凭据不落日志、生成代码沙箱执行、测试不过不许发布、**AI 生成物永不自动发布**。

---

## 1. 连接器清单（候选 20 个）

### 1.1 分类总表

| # | 连接器 | 类别 | API 风格 | 鉴权 | 核心读能力 | 可执行写操作 | 权限粒度 | 限流 / 典型坑 |
|---|--------|------|----------|------|------------|--------------|----------|----------------|
| 1 | **Zabbix** | 监控 | JSON-RPC 2.0 over HTTP | API Token / Bearer（旧 session） | host、item、history、trend、problem、event、trigger、maintenance | `event.acknowledge`、`maintenance.create`、host/item/trigger 增改、`script.execute` | 角色 + **主机组**读写 | 无内置限流；`history.get` 易打爆 DB，必须带时间窗 + `limit` |
| 2 | **Prometheus** | 监控 | REST + PromQL | 无内置（反代 Basic/OAuth2、云上 SigV4） | `query`、`query_range`、`series`、`targets`、`rules`、`alerts` | 无（管理口仅快照/删序列） | 无 RBAC，靠反代/分片 | `--query.timeout` 默认 2m、`--query.max-samples` 默认 50M |
| 3 | **VictoriaMetrics** | 监控 | Prometheus 兼容 REST | Basic（vmauth） | 同上 + `/api/v1/export`、多租户 `/select/{tenant}/` | 无（仅 import/delete） | 租户号（accountID） | `-search.maxQueryDuration`、`-search.maxSeries` |
| 4 | **Alertmanager** | 监控 | REST v2 | 无内置（`--web.config.file`） | `/api/v2/alerts`、`alerts/groups`、`silences`、`status` | 建/删静默、POST 告警 | 单实例级 | 告警不落盘；POST 必须带 `alertname` 标签 |
| 5 | **Grafana** | 监控/可视化 | REST | Basic、Service Account Token(`glsa_`)、OAuth | `/api/search`、`dashboards/uid/:uid`、`/api/ds/query` | 建改看板/文件夹/告警/注释 | Org + 文件夹/看板 + 数据源 | `/api/ds/query` 只是代理，限流在数据源侧 |
| 6 | **Loki** | 日志 | REST + LogQL | 无内置（多租户 `X-Scope-OrgID`） | `query`、`query_range`、`labels`、`series`、`index/stats`、`patterns` | 规则组 CRUD、delete | 租户（OrgID） | `limit` 默认 100；entries/series 上限，超限 429 |
| 7 | **Elasticsearch / OpenSearch** | 日志 | REST + DSL | Basic、API Key、Bearer | `/{index}/_search`（聚合）、`_cat`、`_cluster/health` | 写文档、改模板/ILM | 索引模式 + 角色（DLS/FLS） | `index.max_result_window` 默认 10000；`search.max_buckets` |
| 8 | **Kubernetes** | 容器 | REST（声明式资源模型） | SA Token、证书、OIDC | nodes/pods/events、apps/v1、`pods/log`、metrics.k8s.io | 删 Pod、scale、cordon/drain、rollout、apply、`pods/exec` | **RBAC：verb × resource × namespace** | APF 流控 429 + `Retry-After`；列表需 `limit`/`continue` |
| 9 | **Docker Engine** | 容器 | REST over unix socket/TCP | mTLS 客户端证书 | `/containers/json`、`/logs`、`/stats` | start/stop/restart、exec | 宿主机全权限 | 暴露 TCP 极危险；`/stats` 长连接 |
| 10 | **vCenter / ESXi** | 容器/虚拟化 | REST + SOAP | Session（`POST /api/session`） | VM/主机/数据存储/告警 | 开关机、快照、迁移 | 角色 + 对象级 | 老版本仅 SOAP；会话数与请求节流 |
| 11 | **SNMP** | 网络 | v1/v2c/v3 | community / USM(authPriv) | GET/WALK/BULK，IF-MIB 等 | SET（极少，高危） | community 即全读；v3 用户+视图 | UDP 丢包需重试；WALK 限 OID 子树 + 超时 |
| 12 | **RESTCONF / NETCONF** | 网络 | HTTP+YANG / SSH+XML | Basic / mTLS / SSH | `GET /restconf/data/...`、`<get-config>` | 配置下发（R2/R3） | 厂商模型 + 账户角色 | 模型差异大，需按厂商 YANG 适配 |
| 13 | **SSH（Linux）** | 主机 | 命令执行（无 API） | 密码/私钥/证书/ProxyJump | uptime、free、df、systemctl status、journalctl | 重启服务、改配置、kill 进程 | sudo 规则 + 账户 | 命令注入、host key 校验、输出截断、并发上限 |
| 14 | **WinRM** | 主机 | SOAP/WSMan | NTLM / Kerberos / Basic(HTTPS) | Get-Service、Get-CimInstance、事件日志 | 重启服务、改注册表 | 账户 + 目标机权限 | 5985 明文禁用；需域环境；输出有大小上限 |
| 15 | **Ansible / AWX (AAP)** | 自动化 | REST（`/api/v2/`） | Bearer Token / Basic | job_templates、inventories、jobs、stdout | `POST /job_templates/{id}/launch/` | 组织/团队 + 模板 execute/read | launch 返回 202 需轮询；凭据由 AWX 托管 |
| 16 | **ServiceNow** | ITSM | REST Table API | Basic / OAuth2 | `table/incident`、`change_request`、`cmdb_ci` | 建改事件与变更单、关单 | 角色 + ACL + 表级 | 单页默认返回少（`sysparm_limit`）；实例级配额 429 |
| 17 | **Jira / JSM** | ITSM | REST v3 | Basic、PAT、OAuth2 3LO | `/rest/api/3/search`（JQL）、issue | 建单、流转、评论 | 项目角色 + issue 安全级 | 搜索有结果上限需分页；写受工作流校验 |
| 18 | **NetBox** | CMDB | REST | Token（`Authorization: Token`） | `/api/dcim/devices/`、`/api/ipam/ip-addresses/` | 建设备/IP/机柜 | 用户权限 + 对象约束 | `limit`/`offset`，建议 page ≤ 200 |
| 19 | **CMDBuild / iTop / 蓝鲸** | CMDB | REST / JSON-RPC 风格 | Basic / 会话 / app_code+app_secret | CI 查询、关系查询 | 建 CI、更新属性 | 类级 + 行级 | 模型客户化严重，典型生成模式候选 |
| 20 | **CloudWatch / Azure Monitor / 阿里云云监控** | 云 | Query(SigV4) / ARM REST / RPC+签名 | AK/SK、AssumeRole、AAD OAuth2 | `GetMetricData`、`Microsoft.Insights/metrics`、`QueryMetricList` | 建告警、改标签（谨慎） | IAM Action/Resource、订阅 RBAC、RAM | `GetMetricData` 单次 500 指标；云 API 有 QPS 配额 |

### 1.2 重点平台接口核实

**(1) Zabbix** — 单端点 JSON-RPC 2.0：`POST https://<host>/api_jsonrpc.php`，`Content-Type: application/json-rpc`。鉴权用 API token，请求头 `Authorization: Bearer <token>`（6.4+ 支持）；老方式 `user.login` 拿 session token 放进请求体 `auth`，7.2 起该字段已 deprecated。读：`host.get`、`hostgroup.get`、`item.get`、`history.get`、`trend.get`、`problem.get`、`event.get`、`trigger.get`、`maintenance.get`、`apiinfo.version`。写：`event.acknowledge`、`maintenance.create`、`host/item/trigger.update`、`script.execute`（R3）。权限是**角色 + 主机组**，token 继承用户权限，无方法级 scope，连接器必须自带动作白名单。坑：`history.get` 必带 `time_from`/`time_till` 与 `limit`；`select*` 会撑大响应；长区间走 `trend.get`；无限流，压力全在 DB。

**(2) Prometheus** — REST：`/api/v1/query`、`query_range`、`series`、`labels`、`label/<name>/values`、`targets`、`rules`、`alerts`、`metadata`、`status/tsdb`。返回固定 `{"status":"success","data":{"resultType":"vector|matrix|scalar|string","result":[...]}}`，错误为 `{"status":"error","errorType":...}`。**自身没有鉴权与多租户**，靠反代或云托管（AMP 用 SigV4、Grafana Cloud 用 token）。限流：`--query.timeout`（2m）、`--query.max-samples`（50M）、`--query.max-concurrency`（20）；`query_range` 的 `step` 过小会超采样，建议 ≥15s 或按区间自动算。除 `--web.enable-admin-api` 的快照外无写能力，天然 R0 主力。

**(3) Alertmanager** — REST v2：`GET/POST /api/v2/alerts`、`GET /api/v2/alerts/groups`、`GET/POST /api/v2/silences`、`GET/DELETE /api/v2/silence/{id}`、`GET /api/v2/status`、`GET /api/v2/receivers`。无内置鉴权，靠 `--web.config.file` 或反代。**它是"处置"入口**：静默是最常用的 R1 写操作，必须带 `startsAt`/`endsAt`/`createdBy`/`comment` 且到期自动恢复。POST 告警缺 `alertname` 会 400；告警只在内存/gossip 传播，不能当历史库查。

**(4) Grafana** — REST：`/api/health`、`/api/search`、`/api/dashboards/uid/:uid`、`POST /api/dashboards/db`、`/api/datasources`、`POST /api/ds/query`、`/api/annotations`、`/api/alertmanager/grafana/api/v2/alerts`。生产用 **Service Account Token**（`glsa_`，Bearer），Basic 仅用于自建验证；权限为 Org + 文件夹/看板 + 数据源。建议用 `/api/ds/query` 一个入口拿多源结果，用 `/api/search` 做资产发现；其耗时与限流由底层数据源决定。

**(5) Loki** — REST + LogQL：`/loki/api/v1/query`（瞬时，仅指标型）、`query_range`（日志型必走此）、`labels`、`label/<name>/values`、`series`、`index/stats`（日志量）、`patterns`（模式聚类，适合日志排查）、`tail`（WebSocket）。**API 本身不做鉴权**，多租户靠 `X-Scope-OrgID`；Grafana Cloud 用 Basic（user:access-policy-token）。`limit` 默认 100；服务端有 `max_query_length`、`max_entries_limit_per_query`、`max_query_series`，超限 429，大区间需拆分。

**(6) Kubernetes** — REST：`/api/v1/...`、`/apis/<group>/<version>/...`、`/api/v1/pods?fieldSelector=...`、`/api/v1/namespaces/{ns}/pods/{pod}/log`、`/apis/metrics.k8s.io/v1beta1`（需 metrics-server）。鉴权用 SA Token（projected/bound）、证书或 OIDC；授权走 **RBAC（verbs × resources × namespaces）**，连接器应绑专用 SA + 最小权限。写：`DELETE pod`、`PATCH scale`、`PATCH node.spec.unschedulable`、eviction、`PATCH deployment template annotation`（rollout restart）、SSA、`pods/exec`（R3）。坑：APF 会 429 + `Retry-After`；列表可能被截断，要处理 `metadata.continue`；watch 要 `resourceVersion`。

**(7) SSH** — 无 API，只有命令。设计上不暴露"任意命令"，而是**命令模板 + 参数白名单**：每条模板标注 `mode: read|write`、`sudo`、`timeout`、`outputLimit`。只读示例：`uptime`、`free -m`、`df -h`、`systemctl status {{svc}}`、`journalctl -u {{svc}} --since {{since}} -n 200`、`ss -lntp`。写示例：`systemctl restart {{svc}}`（R2）、`kill -TERM {{pid}}`（R2/R3）。必须校 host key（禁 `StrictHostKeyChecking=no`）、参数转义防注入、连接池上限、输出截断 64KB 并标注。

**(8) Ansible / AWX** — REST：`GET /api/v2/job_templates/`、`POST /api/v2/job_templates/{id}/launch/`（body 带 `extra_vars`、`limit`、`inventory`）→ 202 + job id；`GET /api/v2/jobs/{id}/` 看 `status`（pending/running/successful/failed）、`GET /api/v2/jobs/{id}/stdout/` 取输出。Token 通过 `POST /api/v2/tokens/` 申请（Bearer）或 Basic。**凭据由 AWX 托管，平台永不接触目标机密码**——这是选它做自动化入口的核心理由。launch 风险等于 playbook 风险，因此只允许白名单模板，且模板须带 `readonly: true` 标签才归 R1。launch 异步，需轮询（3–5s）+ 总超时；`extra_vars` 做 JSON Schema 校验。

### 1.3 覆盖度与"必须生成"的边界

**标准件能覆盖（约 80%）**：有公开文档、HTTP/JSON 或标准协议、鉴权属 5 种主流方式之一的平台。观察类几乎全覆盖，K8s/SSH/AWX/ITSM/CMDB 各 1–2 个主力即满足多数客户。**必须生成**的四类：商业 APM/可观测一体机（Dynatrace、听云，专有查询语言 + 多步签名）、国产一体化平台（蓝鲸、嘉为，app_code/app_secret 非 RESTful）、私有 SOAP/XML 网管（华为 eSight、H3C IMC）、gRPC/Protobuf 与仅客户端 SDK 的自研系统（需宿主侧代理）。

---

## 2. 标准连接器 manifest schema

### 2.1 设计原则

- **声明式、可 diff、可测试**：一个连接器 = 一个 YAML，进 Git，CI 做 schema 校验 + 契约测试。
- **凭据只引用不落地**：manifest 只有 `credentialRef`，明文在 Vault/KMS，日志与导出物脱敏。
- **能力先声明后使用**：`capabilities.read/write` 是白名单，运行时越权直接拒绝。
- **一套 schema 覆盖 8 种类型**：类型只影响请求/响应编解码，不影响鉴权、健康检查、测试、审计；版本与目标平台版本都参与路由与告警。

### 2.2 顶层结构

```
Connector
├── apiVersion / kind              # connector.ops/v1, Connector
├── metadata                       # id、name、vendor、version、source、maintainer
└── spec
    ├── type                       # http|promql|zabbix|jsonrpc|ssh|snmp|kubernetes|custom
    ├── transport                  # baseUrl、apiPath、method、headers、proxy/allowlist
    ├── auth                       # 6 种方案 + token 脚本 + credentialRef
    ├── tls / defaults             # verify、CA、超时、重试、限速、分页
    ├── capabilities / actions[]   # 能力白名单 + 动作（请求模板、映射、审批、渲染）
    └── healthCheck / tests / redaction / compatibility / governance
                                   # 探针与门禁用例、脱敏、版本兼容、可见性与配额
```

### 2.3 字段级定义

**metadata**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 全局唯一 `^[a-z][a-z0-9-]{2,40}$`，建议 `<vendor>-<env>` |
| `name` / `vendor` | string | 是 | 展示名、厂商（用于去重与检索） |
| `version` | semver | 是 | 连接器版本，破坏性变更升 major |
| `maintainer` | string | 是 | 责任团队与故障联系人 |
| `source` | enum | 是 | `builtin`｜`community`｜`ai-generated`｜`custom-code`，决定审核等级 |
| `tags` / `license` | array / string | 否 | 市场检索；分享到平台市场必填 license |

**spec.type（8 种）**

| type | 适用 | 内置编解码 | 支持写 |
|------|------|------------|--------|
| `http` | 通用 REST/JSON-RPC 长尾 | 请求模板 + JSONPath 映射 | 是（按动作声明） |
| `promql` | Prometheus 及兼容（VM/Thanos/Mimir/AMP） | PromQL 参数化 + 结果归一化 | 否 |
| `zabbix` | Zabbix 专用 | JSON-RPC 封装 + history/trend 归一化 | 是 |
| `jsonrpc` | 通用 JSON-RPC 2.0 | method/params 模板 | 是 |
| `ssh` | Linux/网络设备命令 | 命令模板 + 白名单 + 输出解析 | 是（R2+） |
| `snmp` | 网络设备 | OID get/walk + MIB 解析 | 极少 |
| `kubernetes` | K8s 及衍生 | 资源模型 + RBAC 探测 + 分页 | 是 |
| `custom` | 生成插件/私有协议 | 沙箱运行时 | 视实现 |

**transport / auth**

| 字段 | 默认 / 必填 | 说明 |
|------|-------------|------|
| `baseUrl` / `apiPath` / `method` | 必填 / 否 | 只允许 https（内网 http 需审批）；单端点型如 Zabbix `/api_jsonrpc.php` |
| `headers` / `encoding` | 否 | 静态头；`json`｜`form`｜`xml`｜`protobuf` |
| `proxy.mode` / `allowlistRef` | 必填 | `direct`｜`platform-egress`｜`tenant-gateway`；出口白名单必须显式绑定 |
| `timeoutMs` / `connectTimeoutMs` | 15000 / 3000 | 长查询动作可覆盖到 60s |
| `auth.scheme` | 必填 | `none`｜`basic`｜`bearer`｜`api_key`｜`oauth2`｜`token_script` |
| `auth.credentialRef` | 必填 | `cred/<tenant>/<id>`，manifest 不含明文 |
| `auth.placement` / `valueTemplate` | 必填 / 否 | `header`｜`query`｜`body`｜`rpc_auth`（query 需默认脱敏）；值模板如 `Bearer {{secret}}` |
| `auth.oauth2` | 按需 | `tokenUrl`、`clientIdRef`、`clientSecretRef`、`scopes[]`、`audience`；平台缓存并在过期前 60s 刷新 |
| `auth.tokenScript` | 按需 | 多步签名/STS：`scriptRef`、`timeoutMs`；沙箱执行，只返回头或参数 |
| `auth.rotationDays` / `tls` | 90 / true | 凭据到期健康检查报警；`verify` 生产禁 false，需审批并记录 CA 与最低 TLS 版本 |

**defaults / capabilities / actions**

| 字段 | 默认 | 说明 |
|------|------|------|
| `retry` / `rateLimit` / `pagination` | 3 / 5 rps / none | 仅幂等读 + 429/5xx/timeout 重试（指数退避，尊重 `Retry-After`）；限速令牌桶，租户可再收紧；分页支持 offset_limit/cursor/page/link_header |
| `capabilities.read/write` / `riskMax` | — / R0 | 能力 id 白名单，write 必须在 actions 中有对应项；动作风险超过 riskMax 即拒绝加载 |
| `capabilities.dataClasses` | — | `infra.metric`｜`infra.inventory`｜`log`｜`secret-adjacent` |
| `actions[].id / toolName` | — | 能力 id；暴露给智能体的工具名（见第 4 节） |
| `actions[].risk / idempotent` | R0 / 读 true | 不得高于 riskMax；写=false，必须带幂等键 |
| `actions[].request` | — | 类型化模板：`method/path/query/body` 或 `rpcMethod/params` |
| `actions[].inputSchema` / `response` | — | JSON Schema 必须 `additionalProperties: false`；response 定义 `rows` JSONPath（如 `$.result[*]`）与 `fields` 列映射 |
| `actions[].approval` | 否 | `required`、`when`（如 `count > 5`）、`approverRole` |
| `actions[].render` | 否 | 默认渲染：`table|timeseries|report|tree|diff` |

**healthCheck / tests / redaction / compatibility / governance**

| 字段 | 说明 |
|------|------|
| `healthCheck.probe` / `intervalSec` / `expect` | 轻量探针（`apiinfo.version`、`/-/ready`、`/api/health`、K8s `/version`），60s，连续 3 次失败置 degraded；期望状态码/字段/延迟 < 2s |
| `tests[]` | 契约用例：`name`、`action`、`params`、`expect`；**至少 3 条且含失败路径**（401、空结果、上游 5xx） |
| `redaction.paths` / `patterns` / `maskStyle` | 响应与日志抹除密码、token、私钥；正则兜底；`partial`｜`full` |
| `compatibility.platformVersions` | 语义化范围如 `>=6.0 <8.0`，超出范围加载告警 |
| `compatibility.deprecatedIn` / `sunsetAt` / `breakingChanges` | 弃用提前 90 天通知，带迁移提示 |
| `governance.visibility` / `allowedRoles` | `tenant-private`｜`tenant-role-groups`｜`platform-market`；默认可用角色组 |
| `governance.quota` | 每分钟调用数、并发、单次最大返回行数 |

### 2.4 完整示例（Zabbix，节选）

```yaml
apiVersion: connector.ops/v1
kind: Connector
metadata: { id: zabbix-prod, name: Zabbix 生产环境, vendor: Zabbix, version: 1.4.0,
            maintainer: ops-platform, source: builtin, tags: [monitoring] }
spec:
  type: zabbix
  transport: { baseUrl: https://zbx.example.com, apiPath: /api_jsonrpc.php, method: POST,
               headers: { Content-Type: application/json-rpc }, timeoutMs: 15000,
               proxy: { mode: platform-egress, allowlistRef: wl-zbx-prod } }
  auth: { scheme: api_key, credentialRef: cred/t-1001/zabbix-prod, placement: header,
          headerName: Authorization, valueTemplate: "Bearer {{secret}}", rotationDays: 90 }
  tls: { verify: true, caRef: ca/internal-root, minVersion: "1.2" }
  defaults: { retry: { maxAttempts: 3, retryOn: [429, 502, 503, 504, timeout] },
              rateLimit: { rps: 5, burst: 10 }, pagination: { style: offset_limit } }
  capabilities:
    read:  [host.list, problem.list, history.query, trend.query, maintenance.list]
    write: [problem.ack, maintenance.create]
    riskMax: R1
    dataClasses: [infra.metric, infra.inventory]
  actions:
    - id: host.list
      toolName: zabbix_host_list
      risk: R0
      idempotent: true
      request: { rpcMethod: host.get,
                 params: { output: [hostid, host, name, status], selectInterfaces: [ip, port, type],
                           selectHostGroups: [name] } }
      inputSchema: { type: object, additionalProperties: false,
                     properties: { group: { type: string }, limit: { type: integer, default: 200 } } }
      response: { rows: "$.result[*]",
                  fields: { hostid: "$.hostid", host: "$.host", ip: "$.interfaces[0].ip",
                            groups: "$.hostgroups[0].name", status: "$.status" } }
      render: { hint: table, title: 主机清单 }
      approval: { required: false }
    - id: problem.ack                    # 写动作：R1，超阈值升级审批
      toolName: zabbix_problem_ack
      risk: R1
      request: { rpcMethod: event.acknowledge,
                 params: { eventids: "{{event_ids}}", action: 6, message: "{{message}}" } }
      approval: { required: false, when: "count(event_ids) > 5", approverRole: sre-lead }
  healthCheck: { intervalSec: 60, probe: { rpcMethod: apiinfo.version, params: {} } }
  tests: [ "正常拉取 3 台主机", "无效 Token → AUTH_FAILED", "空主机组 → 0 行" ]
  redaction: { paths: ["$.result[*].password"], patterns: ["(?i)authorization:\\s*\\S+"], maskStyle: partial }
  compatibility: { platformVersions: ">=6.0 <8.0" }
  governance: { visibility: tenant-role-groups, allowedRoles: [sre, ops-duty] }
```

---

## 3. 通用 HTTP 连接器（零代码接长尾）

### 3.1 模型：三段式

```
请求模板（method + path + query + headers + body，支持 {{var}} 与 {{secret}}）
   → 传输策略（鉴权注入、TLS、超时、重试、限速、分页）
   → 响应映射（successWhen 断言 + rows JSONPath + fields 映射 + 类型转换 + 错误映射）
```

- **只支持 JSONPath 子集**：`$`、`.field`、`[n]`、`[*]`、`..`（可关）、`[?(@.k=='v')]`、`[start:end]`；不支持函数/脚本/聚合——需要就升级 custom，避免在 YAML 里造出半吊子编程语言。
- **模板变量来自动作入参**：先过 `inputSchema`，再类型转换与转义，最后拼接（JSON-RPC 走对象插值，不做字符串拼接）。
- **断言先行 + 错误映射**：`successWhen` 决定成功/失败，避免"HTTP 200 但业务报错"被当成空结果；上游错误映射为 `AUTH_FAILED`/`RATE_LIMITED`/`NOT_FOUND`/`UPSTREAM_ERROR`/`SCHEMA_MISMATCH`，智能体据此重试或换路。

### 3.2 示例 A：取 Zabbix 主机（等价于内置 zabbix 类型）

```yaml
type: http
transport:
  baseUrl: https://zbx.example.com
  method: POST
  path: /api_jsonrpc.php
  headers: { Content-Type: application/json-rpc }
auth: { scheme: api_key, placement: header, headerName: Authorization,
        valueTemplate: "Bearer {{secret}}", credentialRef: cred/t-1001/zbx }
request:
  body:
    jsonrpc: "2.0"
    method: host.get
    params:
      output: [hostid, host, name, status]
      selectInterfaces: [ip]
      filter: { status: "{{status}}" }        # "0"=启用 "1"=停用
    id: 1
response:
  successWhen: { jsonpath: "$.error", absent: true }
  rows: "$.result[*]"
  fields:
    hostid: { path: "$.hostid", type: string }
    host:   { path: "$.host", type: string }
    ip:     { path: "$.interfaces[0].ip", type: string }
    status: { path: "$.status", type: enum, map: { "0": 启用, "1": 停用 } }
  errorMap:
    "$.error.code == -32602": SCHEMA_MISMATCH
    "$.error.code == -32500": UPSTREAM_ERROR
```

> **内置类型不是魔法**，只是把常用平台的请求/映射预置好了。通用 HTTP 能力对齐后，新增平台的平均成本从"写代码 + 发版"降到"30 行 YAML + 跑测试"。

### 3.3 示例 B：Prometheus 取告警

```yaml
type: http
transport: { baseUrl: https://prom.example.com, method: GET, path: /api/v1/alerts }
auth: { scheme: bearer, credentialRef: cred/t-1001/prom }
response:
  successWhen: { jsonpath: "$.status", equals: success }
  rows: "$.data.alerts[*]"
  fields:
    alertname:  { path: "$.labels.alertname" }
    severity:   { path: "$.labels.severity", type: enum,
                  map: { critical: 严重, warning: 警告, info: 提示 } }
    instance:   { path: "$.labels.instance" }
    state:      { path: "$.state" }            # firing | pending | inactive
    active_at:  { path: "$.activeAt", type: datetime }
    value:      { path: "$.value", type: number }
    summary:    { path: "$.annotations.summary" }
  emptyWhen: { rows: 0 }
```

不适合通用 HTTP 的信号：需 HMAC/多步签名（用 `token_script`）、XML/SOAP 或 HTML 表格（转换器或 custom）、聚合/join/递归（custom）、分页以外的任务轮询（场景层编排）、单次 > 5000 行（强制上游聚合或截断并标 `truncated: true`）。

---

## 4. 标准工具契约

### 4.1 工具命名规范

```
{connector}_{noun}_{verb}  例：zabbix_host_list、prom_metric_query_range、k8s_pod_restart
1. 全小写 snake_case，≤ 40 字符，不带版本号（版本在 manifest）。
2. verb 受控词表：get/list/query/search/describe/count/create/update/delete/ack/silence/restart/scale/cordon/run/render。
3. noun 领域词典：host/item/problem/metric/alert/log/pod/node/deployment/incident/change/ci/device/disk/service。
4. 单连接器工具建议 ≤ 12，超出说明抽象层次错了；工具名租户内唯一，多实例用 connector_id 区分而不改工具名。
```

### 4.2 统一输入信封

```json
{
  "required": ["params"],
  "params":  { "type": "object", "description": "动作专属参数，见 action.inputSchema" },
  "scope":   { "tenant": "string", "targets": ["string"],
               "timeRange": { "from": "date-time", "to": "date-time", "window": "^[0-9]+[smhd]$" } },
  "options": { "limit": { "type": "integer", "max": 5000, "default": 200 },
               "dryRun": { "type": "boolean", "default": false },
               "renderHint": { "enum": ["table","timeseries","report","tree","diff"] } },
  "idempotencyKey": { "type": "string", "pattern": "^[a-f0-9]{32,64}$" },
  "approval": { "required": "boolean", "ticketId": "string" }
}
```
约束：`additionalProperties: false`，未知字段一律拒绝；写操作由平台强制注入 `idempotencyKey`，缺省即拒绝调用。

### 4.3 统一输出信封

```json
{
  "tool": "zabbix_host_list", "connector": "zabbix-prod", "ok": true, "risk": "R0",
  "data": { "rows": [ { "hostid": "10084", "host": "web01", "ip": "10.0.1.11", "status": "启用" } ],
            "count": 42, "truncated": false },
  "meta": { "traceId": "tr_9f2c", "elapsedMs": 812, "partial": false, "nextCursor": null,
            "source": "https://zbx.example.com" },
  "render": { "hint": "table", "title": "主机清单（42）", "columns": ["host", "ip", "status"] },
  "audit": { "tenant": "t-1001", "actor": "agent:inspection", "approvalId": null,
             "credentialRef": "cred/t-1001/zabbix-prod", "paramsHash": "sha256:..." },
  "links": [ { "rel": "source", "href": "https://zbx.example.com" } ]
}
```

失败同信封、`ok=false`：`{"ok":false,"error":{"code":"RATE_LIMITED","message":"上游 429，已重试 3 次","retryable":true,"retryAfterMs":2000,"upstream":{"status":429,"bodyHash":"sha256:..."}}}`

### 4.4 风险分级与审批

| 级别 | 定义 | 例子 | 默认策略 | 审计要求 |
|------|------|------|----------|----------|
| **R0 只读** | 无副作用纯查询 | 主机清单、PromQL、日志检索、看板读取 | 自动执行 | trace + paramsHash |
| **R1 低危写** | 可逆、单对象、不改运行状态 | 告警确认、注释、静默、建工单、cordon | 自动执行（生产可配 1 人确认） | 结果 + 回滚手段 |
| **R2 高危写** | 可能影响可用性或多对象 | 重启服务、滚动重启、scale、drain、停 Pod、提变更单 | **强制审批**（生产双人） | 审批单 + dryRun + 前后快照 |
| **R3 禁止** | 不可逆或越权面过大 | 任意 shell、批量删除、改 RBAC、改计费、改网络策略 | 默认禁用，白名单 + 双人 | 录屏 + 审批链 + 事后复核 |

审批矩阵：dev 环境 R0–R2 免审、R3 双人；staging R0/R1 免审、R2 一人、R3 双人；**prod R0 免审、R1 可配一人、R2 双人、R3 禁止（白名单例外）**。补充：R1 但影响对象 > 5（如批量 ack 20 条告警）自动升级审批；变更冻结期 R2 一律拒绝（除非带例外工单）；R2 的 `dryRun=true` 且 diff 为空可直接执行；**租户策略只能加严不能放宽**。

### 4.5 结果渲染建议

| 数据形态 | 渲染 | 说明 |
|----------|------|------|
| 同构多行（主机、Pod、告警） | `table` | 列宽提示；> 100 行折叠 |
| 时序（PromQL matrix、趋势） | `timeseries` | 自动标注单位、阈值线、异常点 |
| 单对象详情 / 变更前后 | `tree`·`diff` | 折叠次要字段；diff 只展示变化字段并标 R2 影响面 |
| 分析结论 | `report` | Markdown → PDF/HTML，带证据链接与时间窗 |
| 空结果 | `table` + 提示 | 明确"查询成功但无数据"，不渲染成错误 |

### 4.6 幂等与审计

| 项 | 规则 |
|----|------|
| 幂等键 | `sha256(tenant|connector|action|canonicalJson(params))`，写操作必带，7 天内重复返回首次结果 |
| dryRun | R1/R2 必须实现，返回"将要做什么 + 影响对象 + diff" |
| 审计字段 | `traceId`、`tenant`、`actor`、`connector`、`action`、`risk`、`paramsHash`、`approvalId`、`startedAt`、`elapsedMs`、`resultStatus`、`egressIp`、`credentialRef` |
| 留存与回放 | 只追加、保留 ≥ 180 天；保存脱敏请求 + 响应摘要 + 快照 id，支持取证与场景复现；审计只记 `credentialRef`，任何情况下不写明文 |

---

## 5. 运维场景库（9 个）

### 5.1 场景总表

| # | 场景 | 触发 | 主要工具 | 最高风险 | 人工确认 | 产物 |
|---|------|------|----------|----------|----------|------|
| S1 | 日常巡检 | 定时/手动 | zabbix_*、prom_*、ssh_disk_check | R0 | 无 | 巡检报告 + findings JSON |
| S2 | 指标异常分析 | 告警联动/手动 | prom_metric_query_range、zabbix_history_query | R0 | 结论采纳 | 分析报告 + 图表 |
| S3 | 告警根因分析 | 告警事件 | am_alert_list、prom_*、loki_*、k8s_* | R1 | 静默/降噪 | RCA 报告 + 关联拓扑 |
| S4 | 故障诊断 | 人工/值班 | 全量只读 + ssh 只读 | R1 | 处置动作（R2） | 诊断记录 + 处置建议 |
| S5 | 容量与成本 | 定时（周/月） | prom_*、cloud_metrics、CMDB | R0 | 无 | 容量报告 + 优化清单 |
| S6 | 变更风险评估 | 变更单创建 | snow_change_get、cmdb、prom_*、k8s_* | R1 | 风险结论 | 风险评分 + 回滚预案 |
| S7 | 日志排查 | 人工/告警联动 | loki_query_range、es_search | R0 | 无 | 日志证据包 + 时间线 |
| S8 | 资产配置核查 | 定时（日） | cmdb_list、k8s_*、ssh、zabbix_host_list | R0 | 差异确认 | 差异清单 + 修正建议 |
| S9 | 日报/周报 | 定时 | 前 8 个场景的产物 | R0 | 发布前过目 | 日报/周报（MD/PDF） |

### 5.2 S1 日常巡检

- **触发 / 输入**：cron `0 8 * * *`、手动或外部调度；`{ targets: 主机组/集群, checks: [cpu, mem, disk, service, cert, backup], window: 24h, thresholdProfile: default|strict }`。
- **编排**：① `zabbix_host_list` 取清单 → ② `prom_metric_query_range` 批量取指标 → ③ 对返回 unknown 的抽样 `ssh_disk_check`（只读 `df -h`）补数据 → ④ analyzer 子智能体按阈值打分去重 → ⑤ reporter 生成报告。
- **人工确认**：无（全只读）。发现"建议立即处置"只生成建议，不执行，由人转 S4。
- **产物 / 成功标准**：巡检报告（MD/PDF）+ `findings[]`（含证据链接、快照 id、时间窗）+ 可选工单草稿；覆盖率 ≥ 95%、每条结论可复现、误报率 < 10%、单次 ≤ 5 分钟。
- **参数化**：`env`、`group`、`window`、`thresholdProfile`、`outputFormat`、`notifyChannel`；阈值走 profile 文件，不写进提示词。

### 5.3 S2 指标异常分析

- **触发 / 输入**：告警联动（同告警 5 分钟内重复 ≥ 3 次）或手动；`{ metric: PromQL 或 item key, instance, window: 6h, baselineWindow: 7d, sensitivity: low|mid|high }`。
- **编排**：① 取当前与基线序列 → ② 计算同比/环比、突变点、周期性偏离（工具算，不靠模型心算）→ ③ 关联同实例其他指标做共变分析 → ④ 输出"是否异常 + 类型（阶跃/漂移/尖刺/缺失）+ 证据"。
- **人工确认**：结论采纳（确认/驳回，反馈进样本库调阈值）。
- **产物 / 成功标准**：分析报告 + 基线对比时序图 + 异常点标注 + 建议动作（不执行）；量化证据（幅度、置信区间）、能区分"数据缺失"与"真实下跌"、结论可被第三方复算。
- **参数化**：`metric`、`baselineWindow`、`sensitivity`、`minAbsChange`、`excludeWindows`（已知窗口如备份时段）。

### 5.4 S3 告警根因分析（RCA）

- **触发 / 输入**：Alertmanager webhook、平台告警事件或人工指定；`{ alertIds, window: 30m, topologyDepth: 2, includeLogs: true }`。
- **编排**：① `am_alert_list` 拉告警与标签 → ② 按 instance/service/namespace 归一故障域 → ③ `prom_*` 查同域指标 → ④ `k8s_*` 查 Pod/Deployment/事件（`fieldSelector=involvedObject.name=`）→ ⑤ `loki_*` 查错误日志并用 `patterns` 聚类 → ⑥ 依赖图推理（来自 CMDB，缺失按标签近似）→ ⑦ 输出 Top3 根因 + 证据链 + 建议。
- **人工确认**：是否静默/降噪（R1，自动执行但需 `comment`）；处置动作转 S4 走 R2 审批。
- **产物 / 成功标准**：RCA 报告（时间线 + 证据链 + 影响面 + Top3 + 建议）+ 关联告警列表；Top3 命中真实根因（人工标注）≥ 60%、给出同根因去重数、每条根因 ≥ 2 条独立证据。
- **参数化**：`service`、`env`、`window`、`topologySource`、`maxDepth`、`includeLogs`。

### 5.5 S4 故障诊断

- **触发 / 输入**：人工发起（值班/专家）、S1/S3 升级或一键诊断；`{ symptom: 文本, targets: [host/pod/service], window: 2h, allowReadOnlySsh: true }`。
- **编排**：① 解析症状生成检查计划（checklist，非自由发挥）→ ② 只读执行 metrics/logs/k8s 状态/ssh 只读 → ③ 结果进"假设-验证"表逐条排除 → ④ 给根因假设 + 置信度 + 下一步 → ⑤ 需处置则生成 R2 动作清单交审批。
- **人工确认**：处置动作（R2 双人）；诊断计划涉及 R3（exec/任意命令）直接拒绝。
- **产物 / 成功标准**：诊断记录（步骤、证据、假设淘汰过程）+ 处置建议 + 回滚方案；步骤可审计可复现、不产生未声明写操作、人工可中途打断。
- **参数化**：`symptomTemplate`、`targets`、`maxSteps`（默认 12，防失控）、`allowReadOnlySsh`。

### 5.6 S5 容量与成本分析

- **触发 / 输入**：周/月定时、扩容评审前；`{ scope: 集群/业务线, window: 30d, forecastDays: 30|90, costProfile }`。
- **编排**：① 采集使用率与峰值（`prom_metric_query_range`、云监控）→ ② 采集容量与配额（K8s requests/limits、主机规格、CMDB）→ ③ 算水位、增长斜率、预测耗尽日 → ④ 识别闲置/超配 → ⑤ 成本折算（单价表来自参数，不让模型猜价）→ ⑥ 输出扩缩容/降配建议。
- **人工确认**：无（只读）；建议进入变更流程前需人确认。
- **产物 / 成功标准**：容量报告（水位表 + 预测曲线 + Top N 风险）+ 成本优化清单（节省估算与假设）；预测区间明确（P50/P90）、成本假设全部显式、建议可落地（具体规格与数量）。
- **参数化**：`scope`、`window`、`forecastDays`、`costProfile`、`targetUtilization`（如 60%）。

### 5.7 S6 变更风险评估

- **触发 / 输入**：ITSM 变更单创建/提交评审（ServiceNow webhook 或轮询）；`{ changeId, changeWindow, affectedCIs, changeType }`。
- **编排**：① 拉变更单与 CI 清单 → ② CMDB 展开依赖（上下游、共享资源）→ ③ 查同域历史变更成功率/回滚率 → ④ 查窗口冲突（已有变更、冻结期、告警风暴）→ ⑤ 查当前健康度（已在告警中则升级）→ ⑥ 输出风险分（1–5）+ 风险项 + 回滚检查项 + 建议窗口。
- **人工确认**：风险结论（评审人确认）；风险 ≥ 4 强制要求回滚方案与值守人。
- **产物 / 成功标准**：风险评估单（附证据与依赖图）+ 回滚清单 + 建议；每个风险项有数据来源、依赖图覆盖 ≥ 90% 关联 CI、输出可直接贴回变更单。
- **参数化**：`changeType`（标准/常规/紧急）、`riskWeightProfile`、`lookbackDays`、`freezeCalendar`。

### 5.8 S7 日志排查

- **触发 / 输入**：人工（贴错误/时间点）、S3/S4 联动；`{ query: LogQL/关键词, service, window: 1h, limit: 200, clusterPatterns: true }`。
- **编排**：① 生成/校验 LogQL（`{service="api"} |= "timeout"`）→ ② `loki_query_range` 取日志（`limit` 分页）→ ③ `index/stats` 看量突变、`patterns` 做聚类 → ④ 抽错误码/堆栈/请求 id 聚合，算首现时间 → ⑤ 必要时跨源关联（ES 补、metrics 佐证）→ ⑥ 输出时间线与证据包。
- **人工确认**：无（只读）。
- **产物 / 成功标准**：日志证据包（时间线 + Top 错误模式 + 首现/峰值时刻 + 原始日志摘录与链接）；窗口与过滤可复现、能识别量级突变、不把"无匹配"当"无故障"。
- **参数化**：`service`、`queryTemplate`、`window`、`limit`、`patternThreshold`。

### 5.9 S8 资产配置核查

- **触发 / 输入**：每日定时、CMDB 变更后或审计前；`{ scope: 业务线/机房, sources: [cmdb, k8s, zabbix, ssh] }`。
- **编排**：① CMDB 拉 CI → ② 监控（Zabbix 主机/agent 在线）与 K8s（Pod/Node）拉实际 → ③ 三方对比 → ④ 抽样 SSH 只读核对（主机名/OS/规格/磁盘）→ ⑤ 输出缺失/多余/属性不一致三类差异。
- **人工确认**：差异确认后是否自动回写 CMDB（R1，需人工点确认）。
- **产物 / 成功标准**：差异清单（表格 + 责任团队）+ 修正建议 + 覆盖度统计；差异可定位到具体 CI 与字段、抽样 ≥ 10%、不产生误删/误改。
- **参数化**：`scope`、`sources`、`sampleRate`、`ignoreFields`（如注释字段）。

### 5.10 S9 日报/周报

- **触发 / 输入**：cron（`0 9 * * *` / `0 9 * * 1`）；`{ period, scope, sections: [可用性, 告警, 事件, 变更, 容量, 待办], format: md|pdf }`。
- **编排**：① 汇总周期内告警/事件/变更 → ② 复用 S1/S5 产物 → ③ 计算 SLI/SLO（未定义则标注）→ ④ 生成初稿 → ⑤ 审校子智能体检查数字一致性与空章节 → ⑥ 分发（邮件/IM/看板）。
- **人工确认**：发布前过目（默认必须，可配置免审）。
- **产物 / 成功标准**：日报/周报（MD/PDF）+ 数据附录（口径说明）；数字可回溯到查询、口径与上期一致、不编造"未定义指标"。
- **参数化**：`period`、`sections`、`sloDefinitions`、`recipients`、`format`。

> 复用要点：场景包只声明需要的能力（不写死连接器），安装时绑定租户实例；场景间通过 `subScenario` 组合（S9 依赖 S1/S5，S3 可调 S4）；全部场景共用 `render` 与 `audit` 规范。

---

## 6. 场景插件化与分享模型

### 6.1 场景 DSL 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` / `version` | string / semver | 场景包唯一 id，版本独立演进 |
| `title` / `summary` | string | 展示名与一句话说明 |
| `inputs` | array | 表单：`key`、`type`（string/duration/enum/number/bool）、`required`、`default`、`label`、`options` |
| `steps[]` | array | 编排：`id`、`kind`（tool/agent/condition/loop）、`ref`、`with`、`onError` |
| `tools[]` | array | 依赖的**能力 id**（非连接器 id），安装时解析绑定 |
| `agents[]` | array | 子智能体：`role`、`model`、`promptRef`、`maxSteps`、`budgetTokens` |
| `prompts` / `guards` | map / object | 提示词支持 `{{input.x}}`、`{{step.y.output}}` 且禁止引用凭据；guards 含 `riskMax`、`requireApproval`、`maxDurationSec`、`maxToolCalls`、`allowedActions` |
| `outputs` / `schedules` | array | 产物模板（report/table/chart/ticket、`templateRef`、`format`）；默认 cron + 时区，租户可改不可超上限 |
| `permissions` | object | `connectorTypes`、`dataClasses`、`writeActions` |
| `visibility` | object | `scope`（role-groups/tenant/platform）、`roleGroups[]` |
| `tests` / `changelog` | array / string | 固定 fixture 的最小用例（分享前必过）；变更说明 |

```yaml
id: inspection.daily.v1
version: 2.1.0
title: 日常巡检
inputs:
  - { key: scope,   type: string,   required: true, label: 巡检范围, placeholder: 主机组/集群 }
  - { key: window,  type: duration, default: 24h,   label: 时间窗 }
  - { key: profile, type: enum,     options: [default, strict], default: default }
steps:
  - { id: inv, kind: tool,  ref: zabbix_host_list,        with: { group: "{{input.scope}}" } }
  - { id: met, kind: tool,  ref: prom_metric_query_range, with: { targets: "{{steps.inv.rows}}", window: "{{input.window}}" } }
  - { id: ana, kind: agent, ref: analyzer,                with: { metrics: "{{steps.met.data}}", profile: "{{input.profile}}" } }
  - { id: rep, kind: agent, ref: reporter,                with: { findings: "{{steps.ana.output}}" } }
tools: [zabbix_host_list, prom_metric_query_range, ssh_disk_check]
agents:
  - { role: analyzer, model: reasoning, promptRef: prompts/analyzer.md, maxSteps: 8 }
  - { role: reporter, model: fast,      promptRef: prompts/report.md,   maxSteps: 3 }
guards: { riskMax: R0, requireApproval: false, maxDurationSec: 300, maxToolCalls: 40 }
outputs: [ { type: report, templateRef: templates/inspection.md, format: [md, pdf] } ]
permissions: { connectorTypes: [zabbix, promql, ssh], dataClasses: [infra.metric], writeActions: [] }
visibility: { scope: role-groups, roleGroups: [sre, ops-duty] }
tests:
  - { name: 空范围优雅失败, input: { scope: "__none__" }, expect: { status: empty, noWrite: true } }
```

### 6.2 可见性与分享状态机

```
draft ─发布(租户内)─▶ tenant_published ─申请分享─▶ share_pending ─管理员审批─▶ platform_review
  ▲                        │                                                    │
  └───── revoked ◀─────────┘                        通过 ▶ platform_published / 驳回 ▶ share_rejected
```

| 状态 | 谁能操作 | 进入条件 | 效果 |
|------|----------|----------|------|
| `draft` | 创建者 | 新建 | 仅自己可见，可测试 |
| `tenant_published` | 创建者 | tests 全过 + 权限自检 | **默认角色组可用**（sre/ops-duty），租户内可见 |
| `share_pending` → `platform_review` | 创建者 / 平台审核员 | 勾选申请 + 填用途与数据说明；租户管理员通过后进入 | 冻结版本等待审批；平台做安全扫描（提示词注入、越权工具、数据外发、依赖类型） |
| `platform_published` | 平台 | 扫描通过 + 双人复核 | 进平台市场，其他租户可安装 |
| `share_rejected` | 平台 | 扫描/复核不通过 | 附理由，退回 `tenant_published` |
| `revoked` / `deprecated` | 创建者/管理员/平台 | 违规、弃用、依赖失效、有替代版本 | 已装实例通知进只读；市场标弃用保留 90 天 |

硬规则：① 分享审批**只能收窄**（`riskMax`、写动作、数据分级），放大需重审；② 安装是"复制 + 绑定"，独立演进，原包升级只提示；③ 平台级场景必须声明 `dataClasses` 与外部依赖，安装时逐项确认；④ 租户内首次启用 R2+ 动作需管理员显式授权一次。

---

## 7. 非标平台"创造模式"

### 7.1 流程（8 步）

| 步 | 名称 | 输入 | 动作 | 产物 | 人工介入 |
|----|------|------|------|------|----------|
| 1 | 目标描述 | 平台名、地址、用途、样例账号 | 结构化需求：读什么、写什么、频次、数据分级 | `intent.yaml` | 用户确认 |
| 2 | API 探查 | 地址 + 凭据 | 探测 `/openapi.json`、`/swagger`、`/api`、`/v1`、`OPTIONS`、登录页技术栈，记录端点与响应样例 | `probe-report.json` | 安全确认白名单 |
| 3 | 草稿生成 | 探查结果 + 目标 | AI 生成 manifest + 动作映射 + 测试用例 + 文档 | `connector.yaml` + `tests/` | — |
| 4 | 沙箱测试 | 草稿 + 录制样本 | 先离线回放（fixture），再只读连真实环境；校验字段/类型/分页/错误路径 | 测试报告 | 允许只读联网 |
| 5 | 人工审核 | 草稿 + 测试报告 | 双审：安全（凭据、越权、外发）+ 领域（语义、单位、空值） | 审核意见 + 放行标记 | **必须** |
| 6 | 灰度 | 放行版本 | 绑定单租户、写操作关闭、只读 30 天观察 | 调用量/错误率/延迟 | 值班观察 |
| 7 | 观察期评审 | 灰度指标 | 错误率 < 2%、无越权、延迟达标 → 提转正 | 转正申请 | 审核员 |
| 8 | 转正入库 | 申请 | 打开声明的写动作、登记目录、标 `source: ai-generated` | 正式连接器 + 变更记录 | 平台 owner |

### 7.2 安全约束（硬性，任一不满足即拒绝发布）

| 约束 | 具体要求 | 校验点 |
|------|----------|--------|
| 网络白名单 | 只能访问 `allowlistRef` 中域名/IP/端口；禁 0.0.0.0/0、禁非标端口 | 发布静态检查 + 出口代理运行时拦截 |
| 只读优先 | 首版只允许 R0/R1；写动作单独申请并逐个声明 `dryRun` | manifest 校验 `riskMax` |
| 凭据不落日志 | 请求头/体、异常栈、探针结果全量脱敏；探测抓包禁入库明文 | 日志扫描 + 假凭据单测 |
| 生成代码沙箱 | 容器内执行：除白名单无外网、根文件系统只读、seccomp、256MB 内存、60s 超时、禁 fork 炸弹 | 沙箱运行时强制 |
| 测试必过 | ≥ 3 条用例，覆盖正常、鉴权失败、空结果；缺一不许发布 | CI 门禁 |
| 不可自动发布 | AI 生成物一律 `draft`，人工双审后才能灰度 | 状态机 |
| 变更可回滚 / 数据外发 | 每版保留上一版 manifest，回滚 ≤ 1 分钟；原始数据不得写往白名单外，LLM 只传脱敏摘要 | 版本仓库 + 网关审计 |

发布前门禁：动作有 `inputSchema` 且 `additionalProperties: false`；读动作有 `rows` 映射 + ≥ 3 个字段类型；错误映射覆盖 401/403/404/429/5xx 且分页正确；脱敏命中测试（Authorization、password、AK/SK）；健康检查 < 2s 且不产生写；文档含能力清单/权限需求/已知限制；标注 `source: ai-generated`。

---

## 8. "标准 vs 生成"判定树

```
Q1 目标平台有公开、可访问的 HTTP(S) API？
├─ 否 ─▶ Q1a 有 SSH/SNMP/WinRM 等标准管理面？
│         ├─ 是 ─▶ 标准连接器（ssh / snmp）
│         └─ 否 ─▶ 生成模式：custom（宿主代理 / 浏览器自动化）
└─ 是
   Q2 鉴权属 {none, basic, bearer, api_key, oauth2}？
   ├─ 否 ─▶ Q2a 能用 ≤50 行脚本换到 token/签名？
   │         ├─ 是 ─▶ 标准连接器（token_script，沙箱执行）
   │         └─ 否 ─▶ 生成模式（custom，含签名逻辑）
   └─ 是
      Q3 响应是 JSON（或可稳定转 JSON）？
      ├─ 否 ─▶ 是 CSV/XML 且结构稳定？是→http + 转换器；否→custom 解析器
      └─ 是
         Q4 映射能用 JSONPath 子集表达（无聚合/无多步）？
         ├─ 是 ─▶ 通用 HTTP 连接器（零代码）
         └─ 否 ─▶ Q4a 只需简单聚合（求和/均值/计数）？
                   ├─ 是 ─▶ 通用 HTTP + 平台侧聚合算子
                   └─ 否 ─▶ 生成模式（custom）
```

**判定原则**：能用 YAML 表达的绝不用代码；必须用代码的，代码进沙箱、进审核、进版本库；生成物与标准件在**契约（第 4 节）与治理（第 6 节）上完全平等**，不因 AI 生成而有特殊通道。

---

## 9. 参考链接

**监控 / 指标**
- Zabbix API：https://www.zabbix.com/documentation/current/en/manual/api ｜ `host.get`：https://www.zabbix.com/documentation/current/en/manual/api/reference/host/get
- Zabbix `history.get`：https://www.zabbix.com/documentation/current/en/manual/api/reference/history/get ｜ `event.acknowledge`：https://www.zabbix.com/documentation/current/en/manual/api/reference/event/acknowledge
- Prometheus HTTP API：https://prometheus.io/docs/prometheus/latest/querying/api/ ｜ PromQL：https://prometheus.io/docs/prometheus/latest/querying/basics/
- Alertmanager API v2（OpenAPI）：https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml ｜ VictoriaMetrics：https://docs.victoriametrics.com/#prometheus-querying-api-usage
- Grafana HTTP API：https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/ ｜ 服务账号：https://grafana.com/docs/grafana/latest/administration/service-accounts/

**日志 / 容器 / 主机**
- Loki HTTP API：https://grafana.com/docs/loki/latest/reference/loki-http-api/ ｜ 多租户：https://grafana.com/docs/loki/latest/operations/multi-tenancy/
- Elasticsearch Search：https://www.elastic.co/guide/en/elasticsearch/reference/current/search-search.html ｜ API Key：https://www.elastic.co/guide/en/elasticsearch/reference/current/security-api-create-api-key.html
- K8s API：https://kubernetes.io/docs/reference/using-api/api-concepts/ ｜ RBAC：https://kubernetes.io/docs/reference/access-authn-authz/rbac/ ｜ APF：https://kubernetes.io/docs/concepts/cluster-administration/flow-control/
- OpenSSH 手册：https://www.openssh.com/manual.html ｜ WinRM：https://learn.microsoft.com/en-us/windows/win32/winrm/portal ｜ SNMP（RFC 3413）：https://datatracker.ietf.org/doc/html/rfc3413 ｜ Docker Engine API：https://docs.docker.com/reference/api/engine/

**ITSM / CMDB / 自动化 / 云**
- Ansible Automation Controller（AWX 同源）：https://docs.ansible.com/automation-controller/latest/html/controllerapi/index.html ｜ ServiceNow 开发者门户：https://developer.servicenow.com/ ｜ NetBox REST：https://netboxlabs.com/docs/netbox/integrations/rest-api/ ｜ iTop REST：https://www.itophub.io/wiki/page?id=3_0_0:advancedtopics:rest_json
- CloudWatch：https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html ｜ Azure Monitor：https://learn.microsoft.com/en-us/rest/api/monitor/metrics/list ｜ 阿里云云监控：https://help.aliyun.com/zh/cms/developer-reference/api-cms-2019-01-01-querymetriclist ｜ Jira REST v3：https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/ ｜ PagerDuty：https://developer.pagerduty.com/api-reference/
