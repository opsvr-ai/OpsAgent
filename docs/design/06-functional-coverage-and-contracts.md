# 功能覆盖与接口/数据契约（开发前补充）

> 状态：设计补充；不写产品代码。  
> 目的：把“功能点 → 页面 → API → 数据 → 验收”逐项闭合，作为各 Sprint 的契约冻结依据。  
> 基线：`00-platform-design.md`、`01-development-plan.md`、`02-feature-matrix.md`。

## 1. 覆盖原则

- 每个功能点必须有：**页面/入口、API/事件、数据实体、权限、验收**。
- 每个 Sprint 开始前冻结本 Sprint 的 OpenAPI/ERD；未冻结不写代码。
- 跨 Sprint 只通过契约协作，不直接读对方表/内部实现。
- 前端只依赖 API 契约与设计 token，不依赖后端 ORM 字段。
- 所有租户数据带 `tenant_id`；所有 R2+ 动作带审批单/审计。

## 2. 功能域与覆盖矩阵

| ID | 功能域 | 功能点 | 阶段 | 页面/入口 | API/事件 | 数据实体 |
|---|---|---|---|---|---|---|
| IAM | 身份 | LDAP 登录、本地管理员、会话、登出 | P1 | `login.html` | `/auth/login`, `/auth/logout`, `/auth/me` | User, Session |
| TEN | 租户 | 租户切换、成员、租户设置 | P1 | `home.html`, `admin-members.html` | `/tenants`, `/tenants/:id/members` | Tenant, Membership |
| RBAC | 角色 | 9 角色、多角色并集、视角 | P1 | 全局角色 pills | `/me/roles`, `/roles` | Role, UserRole |
| SES | 会话 | 创建、流式、工具卡片、审批、产物、恢复 | P1 | `chat.html` | `/sessions`, `/sessions/:id/events` (SSE), `/approvals/:id` | Session, Event, Approval |
| CON | 连接器 | 9 个 P1 连接器、健康、凭据、工具 | P1 | `connectors.html`, `connector-detail.html` | `/connectors`, `/connectors/:id/health` | Connector, CredentialRef |
| SCE | 场景 | 巡检/指标/诊断、运行、报告、发布/共享 | P1 | `scenarios.html`, `report.html` | `/scenarios`, `/scenarios/:id/runs`, `/shares` | Scenario, Run, Report, Share |
| CRE | 创造模式 | dsh cordis 会话、Cordis bundle、沙箱、审核、灰度 | P1 | `studio.html` | `/studio/sessions`, `/studio/bundles`, `/studio/reviews` | StudioSession, Bundle, Review |
| DAT | 插件数据 | 数据集、同步、查询策略、清理、配额 | P1.5 | `data-store.html` | `/connectors/:id/datasets`, `/datasets/:id/query` | Dataset, SyncRun, Retention |
| KNO | 知识 | 四来源、抽取、审核、版本、引用、热更新 | P1.5 | `knowledge.html` | `/knowledge`, `/knowledge/:id/versions`, `/knowledge/search` | Knowledge, Version, Citation |
| MSG | 消息 | 站内信、企业微信、邮件、Webhook、审批卡片 | P1.5 | `messages.html` | `/messages`, `/channels`, `/messages/:id/retry` | Message, Channel, Delivery |
| TSK | 长任务 | 定时巡检、检查点、心跳、告警、暂停/恢复 | P1.5 | `tasks.html` | `/tasks`, `/tasks/:id/checkpoints`, `/tasks/:id/pause` | Task, Checkpoint, Heartbeat |
| CMD | Commander | Incident/Ticket/Evidence/Hypothesis/Approval、事件列表/详情 | P1.6 | `incident.html`, **`incidents.html` 待补** | `/incidents`, `/incidents/:id`, `/incidents/:id/evidence`, `/incidents/:id/hypotheses` | Incident, Ticket, Assignment, Evidence, Hypothesis |
| AGT | Host Agent | 安装、注册、发现、巡航、异常、诊断、资源/配置 | P2-A | Agent 管理页待补 | `/agents`, `/agents/:id`, `/agents/:id/commands` | Agent, HostProfile, Command |
| DEP | 部署/升级 | DeployOrder、预检、canary、健康、回滚 | P2-B | Agent 详情/部署记录待补 | `/deployments`, `/deployments/:id`, `/deployments/:id/rollback` | DeployOrder, Artifact, DeploymentRun |
| ADM | 管理 | 租户、模型、目录、平台管理员 | P1 | `platform-admin.html`, `admin-sharing.html` | `/admin/tenants`, `/admin/models`, `/admin/catalog` | Tenant, ModelProvider, CatalogItem |
| AUD | 审计 | 登录/工具/审批/知识/消息/Agent/部署 | P1–P2 | 审计页/导出 | `/audit`, `/audit/export` | AuditEvent |
| UI | 体验 | 浅色默认、深色、系统、时间自适应；响应式 | P1 | `appearance.html`, `home-dark.html` | `/preferences/theme` | Preference |
| DESK | Desktop | 薄壳、登录、会话、审批、密钥链 | P1.5 | `desktop.html` | 复用 Web API | DeviceSession |
| OPS | 部署运维 | compose、备份、升级、健康 | P1 | 运维手册 | `/healthz`, `/metrics` | Deployment, Backup |

## 3. 关键 API 契约（家族级）

### 3.1 认证/租户/角色

```text
POST /auth/login                 {username,password,tenant?} -> session cookie
GET  /auth/me                    -> {user, roles[], tenants[]}
POST /auth/switch-tenant         {tenant_id} -> new session context
GET  /tenants/:id/members        -> members + roles
PATCH /tenants/:id/members/:uid  {roles[]} -> audit
```

### 3.2 会话/审批

```text
POST /sessions                   {tenant_id, role_view, scenario_id?} -> {session_id}
GET  /sessions/:id/events        SSE: assistant.delta | tool.call | tool.result |
                                  approval.request | approval.resolved | done | error
POST /sessions/:id/prompt        {text}
POST /approvals/:id              {decision:"approve"|"deny", reason?}
```

### 3.3 连接器/场景

```text
GET  /connectors                 -> list + health + capabilities
POST /connectors                 -> create draft (tenant admin)
POST /connectors/:id/test        -> tool contract test
GET  /scenarios                  -> role-visible list
POST /scenarios/:id/runs         -> run; returns run_id
GET  /reports/:id                -> report + evidence refs
POST /shares                     -> share request; approval workflow
```

### 3.4 创造模式

```text
POST /studio/sessions             {goal, platform, credential_ref} -> studio_session_id
GET  /studio/sessions/:id/events  SSE: plan | bundle.created | install | inspect | test
POST /studio/bundles/:id/submit   -> review
POST /studio/reviews/:id          {decision, scope}
POST /studio/bundles/:id/promote  -> gray -> active
```

### 3.5 知识/数据

```text
GET  /knowledge?q=...             -> published chunks + citation + kbVersion
POST /knowledge/:id/versions      -> draft -> review -> publish
GET  /connectors/:id/datasets     -> schema, freshness, quota
POST /datasets/:id/query          {sql|dsl, policy} -> rows + source/freshness
POST /knowledge/publish           -> event knowledge.published {tenant, version}
```

### 3.6 Commander

```text
GET  /incidents?severity=&status= -> list
POST /incidents                   {source, title, severity, host/app} -> incident
GET  /incidents/:id               -> incident + tickets + evidence + hypotheses
POST /incidents/:id/tickets       {assignee_type, target, tool, params}
POST /incidents/:id/evidence      {kind, source, at, hash, confidence, payload_ref}
POST /incidents/:id/hypotheses    {statement, expected_evidence, status}
POST /incidents/:id/approvals     {action, risk, rollback}
```

### 3.7 Host Agent / 部署

```text
POST /agents/enroll               {join_token, csr, host, tenant} -> cert
GET  /agents/:id                  -> status, version, policy, limits, last_seen
POST /agents/:id/commands         {action_id, params, expires_at, signature}
GET  /agents/:id/evidence         -> command results + evidence
POST /deployments                 {app, version, artifact_url, digest, strategy}
POST /deployments/:id/rollback    -> signed rollback order
```

> 以上为家族级契约；每个 Sprint 开始前补 OpenAPI 字段、错误码、幂等键、分页、权限中间件与示例。

## 4. 数据实体（最小集）

| 实体 | 关键字段 |
|---|---|
| Tenant | id, name, status, settings |
| User/Membership | id, tenant_id, ldap_dn, roles[] |
| Session/Event | id, tenant_id, user_id, role_view, status |
| Approval | id, tenant_id, session_id, action, risk, status, approver |
| Connector | id, tenant_id, manifest_version, health, credential_ref |
| Scenario/Run/Report | id, tenant_id, role_scope, status, evidence_refs |
| StudioSession/Bundle | id, tenant_id, profile, bundle_ref, review_status |
| Dataset/SyncRun | id, tenant_id, connector_id, schema, freshness, quota |
| Knowledge/Version/Citation | id, tenant_id, source, acl, version, chunk_ref |
| Task/Checkpoint | id, tenant_id, schedule, state, heartbeat_at |
| Incident/Ticket/Evidence/Hypothesis | id, tenant_id, severity, assignment, source, hash, confidence |
| Agent/Command/DeployOrder | id, tenant_id, host_id, action_id, artifact_digest, risk, approval_id |
| AuditEvent | id, tenant_id, actor, action, target, result, at |

## 5. Sprint 契约冻结门

| Sprint | 必须冻结 |
|---|---|
| P1 Sprint 1 | auth/tenant/RBAC/session/approval/audit、错误码、SSE 事件 |
| P1 Sprint 2 | connector manifest/tool envelope/health、凭据引用 |
| P1 Sprint 3 | scenario DSL/run/report/share、DB/SSH 工具 schema |
| P1 Sprint 4 | studio session/bundle/review、cordis inspect 契约 |
| P1 Sprint 5 | gray/promote/rollback、compose 部署 |
| P1.5 S1–S4 | dataset/query/retention、knowledge/search+version、message/delivery、task/checkpoint |
| P1.6 | incident/ticket/evidence/hypothesis/approval、事件列表 API |
| P2-A | agent enroll/command/profile/limits/config、Eino loop 事件 |
| P2-B | deploy order/artifact/canary/health/rollback、HostAgentExecutor |

## 6. 测试夹具（开发前必须准备）

| 对象 | 夹具 |
|---|---|
| 连接器 | 每个连接器只读 mock + 错误/超时/空结果 + 凭据轮换 |
| dsh | 固定版本运行时、mock model、工具审批 allow/deny |
| Eino | fake ChatModel + tool call 序列 + HITL 暂停/恢复 + 预算超限 |
| 知识 | 4 来源样本、冲突、ACL、版本发布/回滚、热更新事件 |
| 消息 | 企业微信验签/解密、邮件 SMTP、Webhook HMAC、重试 |
| Agent | Rocky/Ubuntu/Debian VM、root/普通用户、cgroup v2、磁盘满、断网 |
| 部署 | 签名/未签名制品、digest 错误、canary 失败、回滚 |
| 安全 | 跨租户、伪造/重放、路径穿越、提示注入、token 泄漏 |

## 7. 仍待补的设计（不阻塞 P0）

1. `studio.html` 改为 dsh cordis 交互（B2）。
2. `incidents.html` 事件列表（B3）。
3. Agent 管理页：安装参数、资源限额、配置加密状态、部署记录。
4. 部署制品规范：v1 支持 systemd 应用 tar.gz + 校验和；rpm/deb/容器后续。
5. P1.6 的 OpenAPI/ERD/威胁模型签字。
6. 每个 Sprint 的 OpenAPI 字段级冻结。

## 8. 验收口径

- 功能：矩阵中每个 ID 至少一条 E2E/集成验收。
- 隔离：所有查询/事件/命令带 tenant 校验；跨租户拒绝。
- 审批：R2/R3 无审批不可执行；审批拒绝/超时可审计。
- 知识：只引用已发布版本；引用带来源/版本；热更新下一 turn 生效。
- Agent：资源限额生效；IP 明文/认证字段密文；无任意 shell；部署可回滚。
- 失败：超时/断网/磁盘满/模型失败必须显式降级，不伪造成功。

## 9. Commander 契约与威胁模型

### 9.1 状态机

```text
Incident: open -> triaged -> investigating -> awaiting_approval -> mitigating -> resolved -> closed
Ticket: queued -> running -> waiting_approval -> succeeded | failed | cancelled
Hypothesis: proposed -> supported | refuted | inconclusive
Approval: pending -> approved | rejected | expired | cancelled
```

### 9.2 实体最小字段

| 实体 | 字段 |
|---|---|
| Incident | id, tenant_id, severity, status, title, source, host/app, started_at, resolved_at |
| Ticket | id, incident_id, assignee_type, target, action_id, params, risk, status |
| Assignment | id, ticket_id, executor, state, attempts, timeout_at |
| Evidence | id, incident_id, kind, source, at, hash, confidence, payload_ref, created_by |
| Hypothesis | id, incident_id, statement, expected_evidence[], status, confidence |
| Approval | id, incident_id, action, risk, scope, approver, expires_at, decision |

### 9.3 威胁模型

| 威胁 | 控制 |
|---|---|
| 日志/告警提示注入 | 内容视为不可信数据；模型只提议；工具白名单/参数 schema |
| 跨租户事件/证据 | RLS + incident.tenant_id + 事件/证据查询强制过滤 |
| 伪造 Agent 证据 | mTLS 设备证书 + 结果签名 + command_id + 时间窗 |
| 伪造/重放指令 | Ed25519 签名 + nonce/过期 + replay cache |
| 越权执行 | R0–R3 + 审批 + 人工 break-glass 不进模型 |
| 模型绕过审批 | Commander 不能直接执行；Executor 二次校验 approval_id |
| 证据投毒 | 证据哈希/来源/时间/置信度；冲突保留；根因需至少 2 条独立证据 |
| 事件风暴/成本 | 去重/分组/抑制；Token/时长/队友/任务预算 |
| 供应链 | 工具/技能/部署制品签名；未签名拒绝 |

### 9.4 P1.6 验收

- Incident 列表/详情/过滤/严重度；
- Ticket 派发 Host/Connector/Specialist；
- Evidence 引用/哈希/冲突；
- Hypothesis 支持/反驳/不确定；
- Approval 与 Web/企业微信同一审批单；
- 无 shell；跨租户拒绝；审计完整。

## 10. 待补 UI（不阻塞 P0）

- `incidents.html`：事件列表、严重度/状态/来源过滤、事件→详情。
- `studio.html`：改为 dsh cordis 会话/bundle/inspect/审核/灰度。
- Agent 管理页：安装参数、资源限额、配置加密状态、巡航/部署记录。