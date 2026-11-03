# OpsAgent 功能矩阵（确认项 → 交付）

> 用途：确认“20 项设计决策 + P1/P1.5/P1.6 + Commander”每一项都有落点、阶段、页面和验收，避免开发中漏项。
> 基线：`docs/design/00-platform-design.md`；计划：`docs/design/01-development-plan.md`。

## 1. 已确认决策

| # | 确认项 | 阶段 | 落点 | 验收 |
|---|---|---|---|---|
| 1 | dsh 复用路线 C（独立运行时 + SDK + 薄 bundle） | P0/P1 | Runtime Agent、`opsagent` bundle、profile | 会话/工具/审批/恢复跑通，不 fork |
| 2 | 隔离：生产独立运行时，试用共享池 | P1 | 租户运行时编排、卷、网络策略 | 跨租户会话/数据拒绝；共享池禁 shell |
| 3 | 连接器：Zabbix / Prometheus / Grafana / Alertmanager / ClickHouse / MySQL / PostgreSQL / Redis / SSH | P1 | `connectors.html`、`connector-detail.html`、工具契约 | 9 个契约测试 + 只读 + 隔离 |
| 4 | 创造模式纳入 P1，且必须完整 | P1 | `studio.html`、8 步流水线、灰度/观察/转正/回滚 | 真实非标平台端到端；测试不过不能发布 |
| 5 | Desktop 薄客户端；本地执行节点 P2 | P1.5 | `desktop.html` | 登录/会话/审批/密钥链 |
| 6 | Commander：选择性 fork/裁剪 dsh-superagent；每租户一个实例；P2-B 接 Host Agent | P1.6/P2-B | `incident.html`、事件指挥 | Incident/Evidence/Approval；无 shell；ConnectorExecutor；HostAgentExecutor |
| 7 | 平台共享由租户管理员审核；平台管理员只治理 | P1 | `admin-sharing.html`、`scenarios.html` | 租户管理员审核后进目录；平台管理员可下架 |
| 8 | 角色目录（9 个内置角色）+ 多角色并集 | P1 | `admin-members.html`、`home.html` | 一个用户多角色；视角切换不越权 |
| 9 | 平台管理员不能看租户会话正文 | P0/P1 | 控制面权限、审计 | 跨租户/正文读取被拒；break-glass 也不允许 |
| 10 | 数据保留 30 天 + 单连接器 5GB | P1.5 | `data-store.html`、清理任务 | 超限停同步/告警；dry-run 可审计 |
| 11 | 查询策略：本地优先/实时优先/仅本地/仅实时 | P1.5 | `data-store.html`、工具结果 envelope | 四种策略生效；stale/回源标注 |
| 12 | 时间自适应 07:00–19:00 浅色，其余深色 | P1 | `appearance.html`、主题 boot | 时区/跨午夜/聚焦即时校验；无 FOUC |
| 13 | 模型：平台 Key 默认 + 租户 BYOK；OpenAI 兼容 + Anthropic | P1 | `platform-admin.html`、Provider | 两种协议流式/工具调用；配额/轮换 |
| 14 | 身份：LDAP + 本地管理员；不接 OIDC | P1 | `login.html`、身份模块 | LDAP 登录、待分配、本地紧急登录；无 SSO |
| 15 | TypeScript 全栈 + dsh 同栈 + 兼容性 | P0/P1 | 控制面、Runtime、`5.6` 契约 | 版本固定；7 项契约测试；升级可回滚 |
| 16 | 审计 180 天热存 + 归档 | P1/P1.5 | 审计流、导出 | 登录/工具/审批/知识/消息/长任务全记录 |
| 17 | 知识自动沉淀永不自动发布 | P1.5 | `knowledge.html`、审核流 | AI 只产出 draft；发布/变更需知识管理员 |
| 18 | 知识采信顺序：文档≈平台运行 > 插件派生 > 对话 | P1.5 | 知识模型、审核 | 冲突保留证据；管理员裁决；可覆盖 |
| 19 | 消息：企业微信（私有部署）/邮件/Webhook | P1.5 | `messages.html`、渠道插件 | 审批卡片/回调/重试/站内信兜底 |
| 20 | 历史会话回溯：管理员显式发起，默认 90 天 | P1.5 | 租户设置、知识抽取任务 | 不自动回溯；30/90/自定义可选；审计 |
| 21 | 知识管理员可由普通成员担任 | P1.5 | 角色、审核权限 | 只授知识审核，不附带运行/连接器权限 |
| 22 | P1 12 周 + P1.5 8 周 + P1.6 8 周 + P2-A 12 + P2-B 8；不裁功能 | 全程 | `01-development-plan.md` | G0–G10；范围变更单 |

## 2. P1 功能拆解

| 功能 | 页面 | 关键验收 |
|---|---|---|
| 多租户/成员/角色 | `admin-members.html`、`platform-admin.html` | 租户隔离；平台管理员分配租户+初始角色；租户管理员维护 |
| 多角色并集/视角 | `home.html`、`admin-members.html` | 多角色徽章；切换视角不放大权限 |
| LDAP/本地管理员 | `login.html` | LDAP bind、待分配、本地 break-glass、无 OIDC |
| 会话/工具/审批 | `chat.html` | 流式、工具卡片、审批 allow/deny、恢复、产物 |
| 9 个连接器 | `connectors.html`、`connector-detail.html` | 契约测试、只读、健康检查、权限矩阵、凭据安全 |
| 3 个场景 | `scenarios.html`、`report.html` | 巡检/指标分析/故障诊断；手动+定时；报告证据 |
| 分享审批 | `admin-sharing.html` | 个人→角色→租户→平台；租户管理员审核；权限不放大 |
| 创造模式 | `studio.html` | 8 步完整；沙箱；测试门禁；灰度/观察/转正/回滚 |
| 主题 | `appearance.html`、`home-dark.html` | 四种模式；浅色默认；用户默认/租户默认/平台兜底 |
| 审计/隔离 | 全局 | 180 天；跨租户拒绝；平台管理员不可读正文 |

## 3. P1.5 功能拆解

| 功能 | 页面 | 关键验收 |
|---|---|---|
| 插件数据沉淀 | `data-store.html` | 自动建库；本地优先/回源；30 天/5GB；自动清理 |
| 知识四类来源 | `knowledge.html` | 插件数据/文档/对话/平台运行均能产出草稿 |
| 知识智能体 | 后端/知识中心 | 抽取 JSON、去重、质检、不能发布、抽取运行记录 |
| 文档接入 | `knowledge.html` | PDF/Word/Excel/MD/HTML/CSV；ACL/版本/删除同步 |
| 对话知识 | 租户设置/知识中心 | 租户统一开关；脱敏；历史显式回溯；审核 |
| 知识审核/版本/引用 | `knowledge.html` | 发布/修改/归档审核；版本；`knowledge.search` 引用 |
| 消息中心 | `messages.html` | 企业微信/邮件/Webhook；审批卡片；重试/回执；站内信兜底 |
| 长任务 | `tasks.html` | 检查点/心跳/恢复；无人值守巡检；平台健康；告警去重；接管 |
| Desktop 薄客户端 | `desktop.html` | 登录、会话、审批、通知、密钥链 |
| 全部页面 | 19 屏 + 事件列表 | 浅色默认、深色、响应式、无溢出/截断；Commander 新增事件列表 |

## 4. P1.6 Commander 功能拆解

| 功能 | 页面/模块 | 关键验收 |
|---|---|---|
| 选择性 fork/裁剪 | Commander 核心 | 保留 core/effects/outbox/policy；每租户一个实例 |
| Incident/Evidence/Hypothesis/Approval | 事件域 | 时间线、证据引用、竞争假设、审批可追溯 |
| Alert/Agent/人工 Source | Source | 去重/分组/严重度；一 Incident 多 Ticket |
| ConnectorExecutor | 插件执行 | Prom/Zabbix/ClickHouse/DB 并行；结果证据化 |
| Commander 工具 | 事件指挥 | 定级/拆任务/派发/根因/审批/报告；无 shell |
| OpsAgent Web 事件指挥台 | `incident.html` + 事件列表 | 时间线/任务板/证据板/假设/审批/Agent 状态 |
| 安全 | 全局 | R0–R3；签名主机动作；人工 break-glass 不进模型 |

## 5. 跨阶段质量门禁

| 门禁 | 何时 | 必须通过 |
|---|---|---|
| G0 技术验证 | W2 | dsh/SDK/工具/审批/模型/隔离/创造模式沙箱/长任务恢复 |
| G1 底座 | W4 | 登录→会话→mock 工具→审批→审计→跨租户拒绝 |
| G2 连接器 | W8 | 9 个契约测试；只读；超时/错误映射；凭据安全 |
| G3 场景/创造 | W10 | 3 场景；真实非标平台生成+审核；测试门禁 |
| G4 P1 | W12 | 全部 P1 验收；性能/备份/兼容；无 blocker |
| G5 数据/消息/文档/长任务骨架 | W14 | 本地优先/回源/清理；WeCom 回调；长任务恢复 |
| G6 知识/巡检/Desktop | W16 | 四来源草稿；无人值守告警；Desktop 审批 |
| G7 P1.5 | W20 | 全部 P1.5 验收；隔离/安全/故障注入；已知限制签字 |
| G8 Commander | W28 | fork/裁剪；Incident/Evidence/Approval；ConnectorExecutor；无 shell；事件指挥 UI |
| G9 Host Agent | W40 | Linux Agent、Eino ADK 轻量 Agent Runtime、注册/发现/采集/巡航/CLI；root 门控；跨租户拒绝 |
| G10 P2-B | W48 | HostAgentExecutor、签名诊断、受控部署/升级、客户端证据、根因闭环、灰度 |

## 6. Server Agent 新增主线（P2-A/P2-B，已确认）

| 能力 | 阶段 | 验收 |
|---|---|---|
| Go 单二进制 + systemd + CLI | P2-A | Linux 安装/升级/回滚；默认 root + 动作门控 |
| 安装 CLI + 配置加密 | P2-A | `--server/--tenant/--join-token-file/--ca-cert`；IP 明文；认证字段 AES-256-GCM |
| 资源限额 | P2-A | CPUQuota/MemoryMax/GOMEMLIMIT/Tasks/IO；空闲 CPU<1%、RSS<100MB |
| Eino ADK 轻量 Agent Runtime | P2-A | Eino ADK；模型走服务端 Gateway；≤8–12 步/预算；空闲不调模型 |
| 注册/证书/自动纳管 | P2-A | 令牌+CSR；未知主机隔离；证书轮换/吊销 |
| 受控发现 | P2-A | OS/服务/应用/部署/配置/日志；证据+置信度；不越界 |
| 应用/数据中心归属 | P2-A | IP/主机名/CMDB；多候选/冲突可审计 |
| 常驻采集/快照 | P2-A | 最长 1 天：5s 1h/30s 6h/5m 24h；1GB/2% 上限 |
| 日常巡航/异常分析 | P2-A | 本地调度；规则聚合+只读 LLM 分析；证据上报 |
| CLI 对话 | P2-A | 本地 socket；LLM 走服务端；R2+ 不能本地批准 |
| 签名诊断指令 | P2-B | 动作 ID/参数/过期/nonce/签名全校验 |
| 排障闭环 | P2-B | 服务端下发→本机证据→结论→审计；工具插件并行 |
| 受控部署/升级 | P2-B | 签名 DeployOrder/制品；预检/canary/回滚；R3 审批 |
| 本地知识 | P2-B | 应用画像/归属/排障缓存；服务端主数据 |
| 安全加固 | P2-B | 伪造/重放/错发/提示注入测试；隔离 |
| 虚拟化/存储/网络 Agent | P3 预留 | 插件协议一致；独立权限 |

## 7. 明确不纳入本期

- Agent Teams 生产接入（P2 评估）。
- Desktop 本地执行节点（P2）。
- 平台市场跨租户安装（P2；P1 只做平台共享目录）。
- K8s 部署、计费、多区域（P2）。
- 钉钉/飞书、OIDC、飞书文档（不接）。
- 任意私有加密协议/SDK 的 AI 自动生成（走人工插件，见计划第 11 节）。
