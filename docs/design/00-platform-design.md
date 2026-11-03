# OpsAgent 运维智能体平台 · 总体设计

> 版本：v0.1（设计稿，待确认）  
> 日期：2026-11-03  
> 范围：产品功能全景、角色权限、智能体底座、连接器与场景、分享机制、多租户隔离、Web / Desktop、部署与一期范围  
> 状态：**尚未进入编码**。文末第 15 节列出需要你拍板的决策，确认后再进入技术验证与开发。

---

## 0. 一页结论

**OpsAgent 是一个以运维场景为中心的智能体平台，不是一个“通用聊天框 + 运维提示词”。**

- **产品闭环**：连接器把 Zabbix / Prometheus / K8s / SSH / 工单系统接进来 → 场景把巡检、指标分析、故障诊断等流程固化下来 → 智能体在租户、角色、工具审批的边界内执行 → 产物、证据、审计留痕 → 场景可以发布给角色、租户，申请后进入平台共享。
- **智能体底座**：以 `deepseek-harness` 作为 agent 运行时，采用 **C 方案**——每个租户一个独立的 `dsh` 运行时（独立 `DSH_HOME`、独立卷、独立进程/容器），平台通过 **SDK JSON-RPC** 驱动；平台不 fork agent-loop，只新增一个薄的 `opsagent` bundle（连接器运行时、审批桥、审计桥、租户上下文、模型路由）和 `tool-*` 插件。
- **多租户**：默认 **独立运行时 + 独立卷**，控制面共享 PostgreSQL 并用 `tenant_id + RLS` 兜底；凭据用租户级信封加密，运行时只拿短时令牌，不落 `DSH_HOME` 明文。
- **主题**：浅色、深色、跟随系统、时间自适应四种；平台默认浅色，用户可设默认；时间自适应默认 07:00–19:00 浅色、其余深色，随设备时区。
- **插件体系**：标准连接器（表单配置）、通用 HTTP 连接器（YAML 零代码）、AI 创造模式（生成 Cordis connector bundle + 测试）、MCP（零代码接已有 server）四条路径；统一工具契约、R0–R3 风险分级和审批矩阵。
- **数据沉淀**：插件声明数据集，平台自动建库；读查询本地优先、过期/缺失回源对端，写入永远实时；按 TTL/行数/配额自动清理，结果标注来源与新鲜度。
- **知识管理**：四类来源——插件数据钻取、知识文档、用户对话、平台运行产物——自动抽取为知识草稿，经知识管理员审核后发布；租户内共享、租户隔离，Agent 只能引用已发布知识。
- **Commander**：指挥智能体 + 专业队友 + 共享任务板/证据板；P1.6 选择性 fork/裁剪 dsh-superagent，每租户一个实例；无 shell，类型化工具 + 签名主机动作 + R0–R3；人类保留 R2+ 审批与接管权。
- **Super Agent 概念**仍保留，但落地名为 Commander；P2-B 接客户端 Agent 做完整根因闭环，P2 再评估 dsh Agent Teams。
- **消息中心**：统一审批、事件、巡检、知识待审通知；默认企业微信（支持私有部署），企业微信对接本身是渠道插件；站内信兜底。
- **分享**：个人 → 角色（默认）→ 租户共享（租户管理员审批）→ 平台共享（租户管理员审核后进入平台目录；平台管理员只做目录治理/下架）。审批只能收窄权限。
- **首期（P1）**：Web、LDAP/本地管理员、多角色、Zabbix/Prometheus/Grafana/Alertmanager/ClickHouse/MySQL/PostgreSQL/Redis/SSH、3 个场景、完整创造模式、会话审批、审计、OpenAI 兼容 + Anthropic、docker-compose 单机私有化；**P1.5**：插件数据沉淀、知识管理、消息中心（企业微信/邮件/Webhook）、长任务/无人值守巡检、Desktop；**P1.6**：Commander（connector-only 事件指挥）；**P2-A/B**：客户端 Agent 与完整根因闭环。
- **本轮已确认**：C 路线、租户隔离、连接器范围、创造模式纳入 P1、桌面薄客户端、Commander 节奏、平台共享由租户管理员审核、角色目录、无 OIDC、数据保留、渠道（企业微信/邮件/Webhook）、历史回溯 90 天、浅色默认。

---

## 1. 需求闭环对照

| 你的要求 | 设计回应 | 章节 |
|---|---|---|
| 运维领域智能体平台 | 以“场景 + 连接器 + 审批 + 审计”组织，而不是以模型为中心 | 2、4 |
| 底层智能体层借鉴 deepseek-harness | 直接以 dsh 作为 agent runtime；复用会话、工具、审批、模型适配、SDK；只加薄 bundle | 5、6 |
| 标准插件对接 Zabbix、Prometheus 等 | 8 种标准连接器 + 通用 HTTP 连接器；表单填写、健康检查、测试用例 | 8 |
| 非标平台通过 AI 创造模式生成插件 | 8 步生成流程 + 沙箱测试 + 人工双审 + 不可自动发布 | 10 |
| 多用户登录、管理 | LDAP 登录 + 本地管理员 break-glass；不接入 OIDC；平台用户 → 租户成员 → 角色 | 3 |
| 多租户 | 控制面 RLS + 每租户运行时/卷/密钥/审计分区；平台管理员默认不读会话正文 | 11 |
| 只有租户管理员能配置插件与对接 | `connector:config`、`plugin:grant` 只授予租户管理员角色 | 3、8 |
| 租户管理员把插件权限分配给角色 | 连接器实例 × 能力 × 角色的三维授权，支持只读/写/审批/数据范围 | 8.6 |
| 插件把对端数据沉淀到本平台 | 插件 storage 声明数据集，平台自动建库；本地优先、回源兜底、自动清理 | 8.7 |
| 运维数据沉淀为知识，知识变更要审核 | 四类来源抽取草稿 → 知识管理员审核 → 发布；租户内共享、租户隔离 | 9.6 |
| 一个用户多个角色，不同角色看不同功能 | 管理身份 + 多职能角色；权限并集、视角切换、视图配置 | 3.1–3.5 |
| 学习 Commander 做运维编排 | 指挥智能体 + 专业队友 + 任务板/证据板 + 审批/接管 + 知识沉淀 | 6.6 |
| 消息中心，默认企业微信 | 站内信 + 企业微信（私有部署）+ 邮件/Webhook；渠道插件化 | 8.8 |
| 通用 LDAP 登录；平台管理员分配租户与角色 | LDAP bind + 组映射；平台管理员负责租户成员关系，租户管理员负责组内权限 | 3.3 |
| 巡检、指标分析等通用场景 | 9 个场景库；P0 三件套：巡检、指标分析、告警根因/故障诊断 | 9 |
| 场景发布成插件供他人使用 | 场景 DSL + 版本化场景包；默认角色可用 | 9.3 |
| 平台级分享、租户管理员确认 | 三级可见性 + 8 态状态机；平台共享由租户管理员审核后进入平台目录，平台管理员只做目录治理 | 9.4 |
| WebUI 与 Desktop 两种形态 | Web 为主控制台；Desktop 复用同一套 API，增加本地执行节点/密钥链/通知 | 12 |
| 模型接入：OpenAI 兼容 + Anthropic | dsh `llm-pi-ai` 已覆盖 `openai-completions` / `openai-responses` / `anthropic-messages`；平台做模型网关、路由、配额 | 7 |
| 主题：浅色 / 深色 / 跟随系统 / 时间自适应，用户可设默认 | 四种模式 + 用户偏好 + 时间窗口 + 优先级；浅深共用同一套语义 token | 12.5 |
| 数据隔离 | 租户级数据库行、对象前缀、Redis 前缀、密钥、运行时卷、审计、出站白名单 | 11 |
| Docker / docker-compose 部署 | 提供单机 compose 与私有化拓扑；运行时镜像固定 dsh 版本 | 13 |

---

## 2. 产品定位

### 2.1 一句话

**把运维团队“看得懂、做得到、审得清”的流程，变成可在权限边界内执行的智能体场景。**

### 2.2 目标用户

| 用户 | 典型诉求 | 平台给什么 |
|---|---|---|
| SRE / 运维工程师 | 告警来了快速定位，巡检别靠人肉 | 会话式诊断、只读工具链、巡检报告 |
| DBA / 中间件 / 容器平台组 | 专业检查项和处置边界 | 角色、连接器权限、风险分级审批 |
| 运维负责人 / 租户管理员 | 谁能用什么、数据不能出界 | 连接器配置、权限分配、分享审批、审计 |
| 平台管理员 | 多租户、模型、合规 | 租户生命周期、模型网关、平台审计 |
| 审计 / 安全 | 谁在什么时候对什么做了什么 | 不可篡改审计、导出、跨租户阻断 |

### 2.3 核心价值

1. **少切换**：告警、指标、日志、主机、工单在同一会话里被引用，而不是开五个窗口。
2. **可复用**：一次排障过程可以固化成场景，参数化后给角色/租户复用。
3. **可控**：只读默认自动，写操作按 R0–R3 审批；权限按角色收窄，场景分享不会放大权限。
4. **可审计**：每次工具调用、审批、分享、配置变更都有租户、执行者、参数摘要和结果。
5. **可生长**：标准连接器覆盖约 80%，长尾用通用 HTTP 或 AI 生成插件补齐，不把平台锁死在几个厂商。

### 2.4 非目标（首期明确不做）

- 不做通用 BI 平台，不替代 Grafana / Prometheus 的可视化。
- 不做完整的 ITSM / CMDB 产品，只做连接器和场景消费。
- 不做无人值守的自动修复闭环；所有 R2+ 写操作必须有人确认。
- 不做移动端原生 App；Web 响应式 + 桌面端覆盖。
- 不在首期做跨租户的数据分析或模型训练。

### 2.5 成功指标

| 指标 | 首期目标 |
|---|---|
| 巡检自动化覆盖率 | 核心系统 ≥ 90% 检查项可由平台执行 |
| 场景复用率 | 租户内 ≥ 40% 的会话引用已发布场景 |
| 审批时延 | R2 审批 P50 < 5 分钟 |
| 工具调用可追溯率 | 100%（含参数哈希、结果摘要、审批单号） |
| 跨租户数据泄露 | 0（红队用例 + RLS 测试） |
| 分享滥用 | 0（平台共享必须双审 + 安全扫描） |

---

## 3. 角色与权限

### 3.1 管理身份与职能角色（两层模型）

角色分成两层：**管理身份**决定租户内的管理边界，**职能角色**决定工作台视角、默认场景、消息订阅和权限包。一个用户可以有多个职能角色，权限取并集；管理身份仍然只有一种。

| 管理身份 | 归属 | 能做什么 | 不能做什么 |
|---|---|---|---|
| **平台管理员** | 平台级 | 建租户、分配用户到租户、模型 Provider、平台目录、平台审计、运行时运维 | 默认不读租户会话正文；不能代替租户管理员做业务授权 |
| **租户管理员** | 租户级 | 配置连接器、分配插件权限、审批租户/平台分享、管理成员与角色、查看本租户审计 | 不能跨租户；不能改平台模型密钥 |
| **租户成员** | 租户级 + 多个职能角色 | 按角色使用连接器/场景、创建会话与个人场景、申请分享、审阅自己范围的知识 | 不能配连接器、不能给自己授权、不能审批 |
| **审计员** | 租户级（只读） | 查看本租户审计、导出报告、查看已发布场景与知识版本 | 不能执行工具、不能改配置、不能发布知识 |

> 关键原则：**平台管理员管“谁属于哪个租户”，租户管理员管“在租户里能干什么”。**  
> 平台管理员可以把用户加入租户并设置初始角色（可多个），但角色的权限内容由租户管理员维护；平台管理员的操作全部进入平台审计。

### 3.2 权限矩阵

| 能力 | 平台管理员 | 租户管理员 | 普通成员 | 审计员 |
|---|---|---|---|---|
| 登录 / 切换有权限的租户 | ✅ | ✅ | ✅ | ✅ |
| 创建会话、运行场景 | — | ✅ | ✅（按角色） | — |
| 创建个人场景 / 草稿 | — | ✅ | ✅ | — |
| 发布到角色（默认） | — | ✅ | ✅（自己的场景） | — |
| 申请租户共享 | — | ✅ | ✅ | — |
| 审批租户共享 | — | ✅ | — | — |
| 推荐平台共享 | — | ✅ | — | — |
| 审核平台共享（安全） | ✅ | — | — | — |
| 配置连接器 / 轮换凭据 | — | ✅ | — | — |
| 把连接器/场景授权给角色 | — | ✅ | — | — |
| 创建/删除角色、分配成员 | — | ✅ | — | — |
| 把用户加入租户、设初始角色 | ✅ | — | — | — |
| 引用知识 / 提交知识草稿 | — | ✅ | ✅（按角色范围） | 只读 |
| 审核并发布知识变更 | — | ✅（或授权知识管理员） | — | — |
| 管理插件数据沉淀 / 清理策略 | — | ✅ | — | — |
| 配置消息渠道 / 企业微信 | — | ✅ | — | — |
| 发起 Commander 事件指挥 | — | ✅ | ✅（按角色与场景） | — |
| 模型 Provider / 路由 / 配额 | ✅ | 只读本租户用量 | — | — |
| 平台审计导出 | ✅ | 本租户导出 | — | 本租户只读 |
| 查看他人会话正文 | ❌（合规 break-glass 需双人） | 仅本租户、按需授权 | 仅自己的 | — |

### 3.3 登录与租户分配流程

```
用户访问 /login
  → 输入企业账号 + 密码（LDAP）
  → 平台 LDAP Bind（ldaps://，服务账号只读查询）
  → 同步/匹配用户，读取 memberOf / OU
  → 平台查 user_tenant_membership：
       ├─ 无记录 → 登录成功但进入“待分配”页（只能看帮助，不能进工作台）
       └─ 有记录 → 建立平台会话，签发短时 access token + HttpOnly refresh cookie
  → 选择默认租户（多租户用户可切换）
  → 租户内加载用户的多个职能角色、权限并集与工作台视图
  → 进入工作台（可切换当前角色视角）
```

**LDAP 设计要点**

- 支持 `ldaps`、StartTLS、自定义 Base DN、用户/组过滤器；服务账号只读。
- 组映射只决定**初始职能角色（可多个）**，最终角色由租户管理员确认（避免 LDAP 组被滥用为越权入口）。
- 首次登录自动建平台用户，但**不会自动获得租户权限**；平台管理员在“平台管理 → 租户成员”里分配。
- 本地管理员账号仅用于平台初始化/断网 break-glass，默认禁用，开启需双人审批并审计。
- 本期**不接入 OIDC/SSO**；身份源固定为 LDAP + 本地管理员。LDAP 不可用时只允许本地管理员紧急登录。

### 3.4 默认职能角色模板

| 角色 | 关注点 | 默认权限 / 工作台 |
|---|---|---|
| 租户管理员 | 租户治理 | 全部连接器配置、全部场景、审批、成员与角色、审计 |
| 值班 SRE | 告警、巡检、故障 | 只读连接器（Zabbix/Prometheus/SSH 只读）、巡检/诊断场景；R2 需审批 |
| 故障诊断专家 | 根因、证据链 | 全量只读 + Commander 指挥；处置建议转审批 |
| DBA | 数据库与存储 | 数据库类连接器与检查项；生产写操作双人审批 |
| 容器平台 | K8s 与发布 | K8s 只读 + 发布诊断；scale/restart 需审批 |
| 网络组 | 网络设备与链路 | SNMP/SSH 只读；网络变更需审批 |
| 变更经理 | 变更窗口与风险 | 变更场景、风险评估、冻结期检查；可审批 R2 |
| 知识管理员 | 知识质量与变更 | 知识审核/发布/归档；知识变更审批；可只读查看相关证据 |
| 审计员 | 合规与追溯 | 审计日志与报告只读；无工具访问 |

### 3.5 一个用户多个角色

- 用户与职能角色是**多对多**；权限取所有角色的并集，不能通过切换视角获得额外权限。
- 顶栏/工作台提供“当前视角”切换（如 值班 SRE / DBA / 知识管理员 / 全部）；切换只改变**导航、首页组件、默认场景和消息订阅**，不改变安全边界。
- 每个角色带一个**工作台视图配置**：导航项、首页卡片、默认场景、知识范围、消息路由；角色升级时视图配置版本化。
- 权限快照在会话启动时冻结；角色/权限变更只影响新会话，正在进行的会话保持原快照（审计可追溯）。
- 用户有一个**主角色**用于默认落地页、IM 通知和值班路由；其余角色可随时切换。
- 知识管理员是普通成员上的一个职能角色，不要求租户管理员身份；租户管理员可授权某人只做知识审核。
- 自定义角色（P2）允许租户复制内置角色并调整权限/视图，但不能突破平台的安全上限。

---

## 4. 平台功能全景

### 4.1 模块树

```
OpsAgent
├── 工作台
│   ├── 当前角色视角（值班 SRE / DBA / 知识管理员 / 全部）
│   ├── 今日概览（巡检、告警、待审批、运行健康）
│   ├── 需要关注（严重发现、凭据过期、配额预警、知识待审）
│   ├── 进行中的会话 / 常用场景 / 快捷指令
│   └── 平台动态（脱敏审计摘要）
├── 智能体会话
│   ├── 会话列表、搜索、归档、导出
│   ├── 流式回答 + 工具调用卡片 + 审批卡片 + 产物
│   ├── 运行轨迹（步骤、耗时、审批状态）
│   ├── Commander 指挥视图（队友、任务板、证据、交接）
│   ├── 上下文引用（@连接器 / @场景 / @知识 / @报告）
│   └── 模型选择、预算与 Token 用量
├── 场景中心
│   ├── 场景卡片、分类、权限标识、运行记录
│   ├── 参数表单、定时计划、手动运行
│   ├── 运行详情 / 巡检报告 / 证据与产物
│   └── 创建、编辑、测试、发布、申请共享
├── 知识中心
│   ├── 四类来源：插件数据钻取 / 知识文档 / 用户对话 / 平台运行
│   ├── 运维知识库（故障案例、Runbook、拓扑、基线、变更手册）
│   ├── 自动沉淀草稿、证据链、置信度、来源
│   ├── 知识审核（知识管理员）、版本与变更记录
│   └── 租户内共享 / 租户隔离 / 过期复审
├── 消息中心
│   ├── 站内信、审批、事件、巡检、知识待审
│   ├── 企业微信（默认，支持私有部署）、邮件、Webhook
│   ├── 渠道绑定、消息模板、路由与静默
│   └── 投递记录、重试、回执
├── 集成与插件
│   ├── 标准连接器（Zabbix、Prometheus、Grafana、Alertmanager、ClickHouse、MySQL、PostgreSQL、Redis、SSH、K8s、Kafka）
│   ├── 通用 HTTP 连接器（请求模板 + JSONPath 映射）
│   ├── 连接器实例配置、健康检查、凭据轮换
│   ├── 工具能力清单、Schema、风险级别
│   ├── 插件数据沉淀（数据集、同步、清理、本地优先查询）
│   ├── 角色权限矩阵
│   └── 版本、变更记录、审计
├── 创造模式
│   ├── 自然语言描述目标平台
│   ├── AI 探查 OpenAPI / swagger / 端点
│   ├── 生成 manifest、动作映射、测试用例
│   ├── 沙箱测试（离线 fixture + 只读真实环境）
│   ├── 租户管理员审核（安全 + 领域检查）
│   └── 灰度、观察、转正、版本回滚
├── 服务器 Agent
│   ├── Go 单二进制、注册/证书、自动纳管
│   ├── 受控发现、应用画像、配置/日志位置
│   ├── 常驻采集、本地快照、异常上报
│   ├── CLI 对话、签名诊断指令、证据回传
│   └── 虚拟化/存储/网络 Agent（插件预留）
├── 租户治理
│   ├── 成员与角色
│   ├── 分享审批（租户共享 / 平台共享，租户管理员审核）
│   ├── 租户审计
│   └── 租户设置（模型策略、配额、隔离模式）
├── 平台管理
│   ├── 租户生命周期
│   ├── 租户成员分配（平台管理员）
│   ├── 模型 Provider / 路由 / 配额
│   ├── 平台插件目录 / 平台共享目录治理
│   └── 平台审计 / 系统健康
└── 客户端
    ├── Web（React，主流浏览器）
    └── Desktop（Electron；登录、密钥链、本地执行节点、通知）
```

### 4.2 一个完整用户旅程

1. **平台管理员**创建租户“星河银行 · 运维中心”，从 LDAP 同步用户，把林晚设为租户管理员，把陈志远加入租户并赋予「值班 SRE + DBA」两个职能角色。
2. **租户管理员林晚**接入 Zabbix / Prometheus，启用插件数据沉淀（主机、告警、指标数据集），设置“本地优先、过期回源”；配置企业微信（私有部署）为默认消息渠道，把审批和巡检通知路由到值班角色。
3. **陈志远**登录 Web，当前视角为「值班 SRE」；工作台只展示值班关注的告警、巡检、事件和待审批。他从消息中心收到一条 Zabbix 告警。
4. 他运行“核心系统日巡检”；工具优先读取插件数据库中的最新同步数据，缺失或过期时回源 Zabbix/Prometheus；巡检发现 MySQL 连接池风险。
5. 他从报告发起「Commander 事件指挥」：指挥智能体拆解任务，派出指标、日志、DBA 三个队友并行取证，共享任务板与证据；SSH 只读查询的审批通过企业微信卡片确认。
6. 事件解决后，指挥智能体把时间线、根因、处置和证据整理成**知识草稿**；知识管理员林晚审核、补充适用条件后发布，知识在租户内共享。
7. 他把“告警根因分析”场景从个人草稿发布到值班角色；一周后申请租户共享，林晚审批通过；再申请平台共享，林晚审核后进入平台目录，平台管理员只做目录治理。
8. 所有步骤在审计里可查：谁、什么租户、什么角色、什么工具、命中了哪份知识、谁审批、结果如何。

---

## 5. 技术架构

### 5.1 总体分层

```
┌──────────────────────────────────────────────────────────────────┐
│  Web (React)                    Desktop (Electron)               │
│  登录 / 工作台 / 会话 / 场景 / 连接器 / 审批 / 管理              │
└───────────────┬──────────────────────────────┬───────────────────┘
                │ HTTPS + WSS                  │ HTTPS + mTLS（本地节点）
┌───────────────▼──────────────────────────────▼───────────────────┐
│  API Gateway / BFF                                               │
│  TLS、速率限制、CORS、CSRF、access token 校验、租户解析、审计入口 │
└───────────────┬──────────────────────────────────────────────────┘
                │ 内部 mTLS
┌───────────────▼──────────────────────────────────────────────────┐
│  Control Plane（TypeScript / Fastify）                            │
│  ├ Identity：LDAP、本地管理员、会话、用户、租户成员                   │
│  ├ IAM：多角色、权限并集、工作台视图、策略                        │
│  ├ Integration：连接器实例、manifest、健康检查、凭据引用          │
│  ├ Plugin Store：数据集 schema、同步任务、TTL/清理、本地优先查询  │
│  ├ Knowledge：知识库、自动沉淀、审核、版本、检索（租户隔离）      │
│  ├ Scenario：场景包、版本、运行记录、产物                         │
│  ├ Sharing：可见性、审批、平台目录                                │
│  ├ Messaging：消息中心、模板、路由、渠道插件（企业微信默认）      │
│  ├ Model Gateway：Provider、路由、配额、用量                      │
│  ├ Audit：追加写、导出、保留策略                                  │
│  └ Runtime Orchestrator：运行时容器生命周期、会话路由、审批桥     │
└───┬───────────┬───────────┬───────────┬───────────┬──────────────┘
    │           │           │           │           │
 PostgreSQL   Redis      MinIO/S3     Vault/KMS    OTel Collector
 (RLS/知识/   (队列/缓存) (产物/附件)  (租户密钥)   (指标/日志/追踪)
  插件数据集)                          + 向量索引
    │
    └───────────────┬──────────────────────────────────────────────┐
                    │ 内部调用（mTLS HTTP / WS）                     │
┌───────────────────▼──────────────────────────────────────────────┐
│  Runtime Agent（每租户一个容器/进程）                             │
│  mTLS API ⇄ dsh SDK JSON-RPC（stdio 子进程）                      │
│  dsh --profile sdk + opsagent bundle                             │
│  ├ ops-tenant-context：注入 tenant/user/roles/permission 快照     │
│  ├ ops-connector-runtime：加载 manifest，注册工具                 │
│  ├ ops-scenario-runner：执行场景 DSL，管理子智能体                │
│  ├ ops-super-agent：事件指挥、队友、任务板、证据、知识沉淀        │
│  ├ ops-long-task：长任务检查点/心跳/恢复，无人值守巡检             │
│  ├ ops-approval-bridge：tools/pre-execute → 平台审批中心          │
│  ├ ops-audit-bridge：session/event + tool 结果 → 审计流           │
│  ├ ops-credentials：从平台取短时凭据（不落盘）                    │
│  └ 租户独立 DSH_HOME 卷（会话、workspace、attachments）           │
└───────────────────┬──────────────────────────────────────────────┘
                    │ 出站白名单代理
┌───────────────────▼──────────────────────────────────────────────┐
│  Zabbix / Prometheus / Grafana / K8s / SSH / CMDB / 工单 / 自定义 │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 为什么选 C 方案（不 fork）

调研结论（`docs/design/research/harness-capability-map.md`）：

- dsh 是**一棵 Cordis 插件树**，唯一支持的启动入口是 `dsh <profile>`；agent-loop、会话、工具、模型、沙箱都是插件。
- 已有 **SDK stdio JSON-RPC**（`session/prompt`、`session/resume`、`approval/request`、`session.event`），适合平台驱动。
- 已有 **pi-ai** 多协议适配（`openai-completions`、`openai-responses`、`anthropic-messages`），满足模型要求。
- 但 dsh **没有 user_id / 租户 / 多用户登录**；Web 是单 owner Cookie；会话与凭据都在单个 `DSH_HOME`；凭据是明文文件。
- 因此：**按租户隔离进程/容器是唯一与现状自洽的方式**；在多用户 Web 上做统一 SPA 才需要 fork。

| 维度 | 选择 |
|---|---|
| 复用方式 | dsh 作为独立 agent runtime，平台通过 SDK JSON-RPC 调用 |
| 扩展方式 | 新增 `opsagent` bundle + `tool-*` 插件 + skills + MCP；不改 dsh 源码 |
| 升级方式 | 固定 dsh 版本镜像；升级 = 换镜像 + 会话重放回归 |
| 多租户 | 每租户独立运行时容器 + 独立 `DSH_HOME` 卷 |
| 平台职责 | 认证、RBAC、插件/场景目录、审批、审计、模型网关、配额、运营 |
| 风险 | SDK 仅 stdio，需要 Runtime Agent 桥接；同租户多用户的 per-agent 工具收窄需 P0 验证；上游 API pre-stable |

> 什么时候才 fork：必须做“单进程多租户”或“统一 Web 多用户 UI 且不能每用户一个容器”时。fork 顺序：connection/认证 → remote-access/RBAC → session-controller/持久化 → credentials/settings/workspace，最后才动 `SessionEventMap`。

### 5.3 组件职责

| 组件 | 职责 | 技术 |
|---|---|---|
| `opsagent-web` | 控制台 SPA；登录、工作台、会话、场景、连接器、管理 | React 19 + Vite + TypeScript |
| `opsagent-gateway` | TLS 终止、限流、token 校验、租户上下文注入、审计入口 | Fastify / Envoy 可选 |
| `opsagent-control` | 身份、多角色 IAM、集成、插件数据、知识、场景、分享、消息、模型、审计、运行时编排 | Fastify + Kysely/Drizzle + PostgreSQL（pgvector） |
| `opsagent-worker` | 定时场景、数据同步/清理、知识抽取、消息投递/重试、健康检查、分享扫描、运行时回收、用量汇总 | Node + BullMQ（Redis） |
| `opsagent-runtime-agent` | 每租户运行时守护进程：spawn dsh 子进程、mTLS API、stdio JSON-RPC 桥、会话归属、重启与日志 | Node 24 + Fastify |
| `opsagent-runtime` | 每租户 dsh 运行时；profile + ops bundle；Commander 编排 | Node 24 + dsh 0.2.x + Cordis 插件 |
| `opsagent-desktop` | Electron 壳 + 本地执行节点 | Electron + Node sidecar |
| `opsagent-connectors` | 标准连接器/渠道插件 manifest、测试 fixture、文档 | YAML + JSON Schema |
| `opsagent-scenarios` | 场景 DSL、提示词、报告模板 | YAML + Markdown |

### 5.4 一次会话的调用链

```
1. Web 发起 POST /api/sessions/{id}/messages
2. Gateway 校验 access token → 解析 user/tenant → 注入 tenant context
3. Control 校验租户成员、多角色权限、场景/连接器授权 → 生成 runtime capability token
4. Orchestrator 通过 mTLS 调用该租户 Runtime Agent（不直接跨容器拿 stdio）
5. Runtime Agent 校验 capability token，把 prompt 转给 dsh 子进程的 stdio JSON-RPC
6. dsh agent-loop 组装 prompt + 工具 schema（按会话/用户/角色收窄）
7. 模型调用经 Model Gateway 路由到 OpenAI 兼容 / Anthropic
8. 工具调用：
   a. ops-connector-runtime 校验租户/连接器实例/能力/风险
   b. 查询类工具先读插件数据集：新鲜 → 本地；过期/缺失 → 回源对端，结果标记 source/freshness
   c. R0 直接执行；R1 按策略；R2/R3 通过 tools/pre-execute 返回 ask
   d. 平台审批中心推送 Web/Desktop/企业微信；用户确认/拒绝；超时拒绝
   e. 执行结果脱敏后返回模型，同时写审计、按需回写数据集
9. session.event 实时推给 Web（WebSocket），审批/工具卡片更新；消息中心按路由推送
10. 回合/事件结束，产物写 MinIO，元数据写 PostgreSQL，触发知识抽取草稿与审计归档
```

### 5.5 仓库布局建议

```
OpsAgent/
├── apps/
│   ├── web/                  # React 控制台
│   ├── control/              # Fastify 控制面
│   ├── worker/               # 定时/异步任务
│   └── desktop/              # Electron（P2）
├── packages/
│   ├── runtime-bundle/       # Cordis bundle：ops-tenant-context 等
│   ├── connectors/           # 标准连接器实现/manifest
│   ├── contract/             # 共享类型、工具信封、manifest schema
│   └── ui/                   # 设计系统组件
├── connectors/               # 内置 YAML（Zabbix/Prometheus/...）
├── scenarios/                # 场景 DSL 与模板
├── deploy/
│   ├── docker-compose.yml
│   ├── images/runtime/Dockerfile
│   └── helm/                 # P2
├── docs/design/              # 本设计 + 两份调研
├── deepseek-harness/         # 上游参考，不修改
└── pnpm-workspace.yaml
```

> dsh 不修改；运行时镜像从固定 commit 构建（若官方 npm 包可用则优先 npm）。平台只依赖 `@deepseek-ai/dsh/profile-boot` / SDK 协议 / `defineTool` 等稳定面，不依赖内部 `src`。

---

### 5.6 与 deepseek-harness 的兼容性

OpsAgent 与 dsh 的关系是“运行时依赖”，不是“源码分支”。兼容性策略如下：

| 层面 | 约定 |
|---|---|
| 版本 | 每个平台版本固定一个 dsh 版本（如 `0.2.x`），在 `runtime.lock` 中记录 commit/包版本；不跟随浮动 latest |
| 启动 | 只用 `dsh <profile>`（`opsagent-runtime` profile）；不绕过 launcher 直接拼 Cordis 树 |
| 扩展 | 只用 `bundle` + `profile patch` + `defineTool` + `ctx.tools` + `ctx.credentials` + `skill` + MCP + `subagent`；不 import dsh 内部 `src`，不改 agent-loop |
| 协议 | SDK JSON-RPC（initialize/session/approval/event）作为平台与 runtime 的稳定契约；Runtime Agent 负责 stdio 桥接 |
| 模型 | 只用 `llm-pi-ai` 的公开 provider 配置（OpenAI 兼容 / Anthropic）；自定义 adapter 走公开注册面 |
| 会话 | 只读写公开的 SessionEvent/JSONL；升级前做旧格式只读打开 + resume 回归；不手改已提交 generation |
| 工具 | 工具 schema、结果信封、审批钩子由平台定义；dsh 侧只按公开 `defineTool` 契约注册 |
| 长任务 | 使用 dsh `jobs`/`schedule` + 平台任务实体；不假设会话进程一直存活；检查点/恢复由平台负责 |
| 实验能力 | Agent Teams 等 experimental 能力通过 feature flag 隔离；不可用时回退平台任务板 |

**兼容性测试门禁（每次升级 dsh）**

1. 安装/初始化、profile 启动、bundle 加载、沙箱失败关闭。
2. 会话 create/resume/fork；旧版本会话只读打开与 resume。
3. 工具注册、参数校验、审批 allow/deny、事件回流。
4. OpenAI 兼容与 Anthropic 流式、工具调用、错误码。
5. 租户隔离、credential provider、会话归属。
6. 长任务检查点/恢复/取消/超时。
7. 至少一个真实租户灰度 72 小时，再全量；保留上一版镜像回滚。

> 不把 dsh 的 experimental API 作为平台合同；升级失败必须能回滚运行时镜像，不影响控制面数据。

### 5.7 服务器 Agent（Host Agent）

在每台服务器上部署一个 Go 单二进制 Agent（`opsagentd` + `opsagent` CLI），作为平台在主机侧的**受控 LLM Agent**：内置轻量 Agent Runtime，受服务端 Commander 控制，但不替代服务端控制面，也不做无边界远程 Shell。

**核心能力**

- **Eino ADK 轻量 Agent Runtime**：ChatModelAgent/ReAct + 自定义 Tool + compose Graph；Wake → Context → Plan（服务端 LLM Gateway）→ Act（类型化工具）→ Verify → Report → Sleep；单次 8–12 步、Token/时长预算；空闲不调模型。
- 初始化：一次性令牌注册、CSR/mTLS、受控发现（OS/服务/应用/部署方式/配置/日志位置）、应用系统/数据中心归属、本地知识落盘。
- 日常巡航：本地调度检查 OS/应用/服务/容量/日志/配置；异常先本地规则聚合，再触发只读 LLM 分析并上报。
- 排障：服务端 Commander 下发签名诊断指令，Agent 在本机执行只读检查、回传证据与结论；R2+ 动作需审批。
- **受控部署/升级**：P2-B 支持签名 DeployOrder/制品、预检、停止/替换/启动、健康检查、canary、回滚；R3 变更审批，不做任意 Shell。
- 边界：只出站、不开放入站；动作 ID + 结构化参数；**默认 root + 动作级权限门控**；快照最长 1 天、磁盘硬上限。
- 安装与配置：CLI 传入服务端 IP/端口、租户、join token/CA；IP 明文保存，认证信息用 AES-256-GCM 字段级加密；私钥 0600/TPM。
- 资源限额：systemd `CPUQuota=50%`、`MemoryMax=256M`、`GOMEMLIMIT=200MiB`、任务/IO 限制；Agent 自身 OOM 优先于业务。
- 扩展：虚拟化/存储/网络 Agent 作为插件，共用注册、策略、指令、审计协议；P3 扩展高级部署与可选本地推理。

**与其他模块的关系**

- 服务端新增 Agent Gateway、Enrollment/CA、Agent Registry/CMDB、Policy/Skills、Command/Evidence、LLM Gateway。
- Commander 通过工具插件同时使用 Host Agent、Zabbix/Prometheus、ClickHouse、DB、知识库。
- 应用/数据中心主数据在服务端 CMDB；Agent 本地知识是可离线使用的副本。
- 与 dsh 的关系：服务端 Commander 用 dsh；Host Agent 是独立 Go LLM Agent（Eino ADK），模型走服务端 Gateway，不把 dsh/Node 运行时塞进每台主机。

**路线**

P1/P1.5/P1.6 的 28 周不变；Server Agent 作为独立 P2-A（12 周，轻量 LLM Agent/发现/巡航）+ P2-B（8 周，诊断/受控部署/根因）主线；P3 扩展虚拟化/存储/网络 Agent 与高级部署。

详见：`docs/design/03-server-agent.md`；汇报材料：`docs/design/server-agent-report/index.html`。

## 6. 智能体底座：如何复用 deepseek-harness

### 6.1 复用面

| 能力 | dsh 提供 | 平台怎么用 |
|---|---|---|
| Agent loop | `core/agent-loop`，turn/step 状态机 | 直接用，不改 loop |
| 会话 | 追加式 `SessionEvent` JSONL（v4） | 每租户 `DSH_HOME` 下持久化，控制面只存索引 |
| 工具 | `ctx.tools.register(defineTool())` + 审批流水线 | 新增 `ops-connector-runtime` 动态注册 |
| 模型 | `ctx.llm` + `llm-pi-ai` 多协议 | 平台模型网关 + 每租户路由 |
| 审批 | `tools/pre-execute`、`approval/request` | 桥接平台审批中心 |
| 沙箱 | `ctx.sandbox` 三模式 | 容器边界为准；默认只读/工作区写 |
| Subagent/Workflow | 内置 | 场景里拆分 analyzer / reporter 子智能体 |
| Skill | 文件系统扫描 + 热更新 | 租户/平台 runbook 以 skill 挂载 |
| MCP | stdio / streamable-http | 已有 MCP server 零代码接入 |
| SDK | stdio JSON-RPC | 平台后端控制会话、审批、事件回流 |

### 6.2 `opsagent` bundle

基于 `dsh-base`，新增/调整：

1. **ops-tenant-context**：从 runtime 启动参数/本地 socket 读取 `tenant_id`、`user_id`、角色快照、请求级 capability token；注入系统提示与工具作用域；拒绝任何跨租户 ID。
2. **ops-connector-runtime**：加载当前租户已授权的连接器 manifest，注册工具；工具名 `{connector}_{noun}_{verb}`；执行前做租户/能力/风险三重校验。
3. **ops-scenario-runner**：把场景 DSL 编译成 agent 任务/子智能体；限制 `maxSteps`、`maxToolCalls`、`maxDurationSec`。
4. **ops-approval-bridge**：`tools/pre-execute` 返回 `ask` 时调用平台审批 API；审批结果落会话事件 + 审计；超时/断线按拒绝处理。
5. **ops-audit-bridge**：订阅 `session/event`，把 `tool/call`、`tool/result`、`approval/*`、`turn/*` 摘要写入平台审计流；不写明文凭据。
6. **ops-credentials**：实现 `ctx.credentials` provider，从平台取短时凭据；内存缓存，不落 `.credentials.yaml`。
7. **ops-model-policy**：限制可用模型/路由；与 `llm-pi-ai` 配置对接。
8. **默认权限收紧**：`permission-presets` 默认 read-only；禁用 `tool-terminal`、`browser-use`、`computer-use`、`plugin-manager`、运行时改插件等高危行；只允许平台注册的 MCP server。
9. **per-session 工具收窄**：同一租户进程内可能有不同用户/角色；创建 Agent 时通过 `agent.ctx` / `ctx.tools.restrict` 注入该会话的能力白名单，避免用户 A 的授权被用户 B 的会话复用。P0 必须验证 dsh 的 per-agent scope 能覆盖动态注册工具；若隔离不可靠，降级为“每用户一进程”。

### 6.3 工具注册示例

```ts
export const name = 'tool-zabbix'
export const inject = ['tools', 'credentials']

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'zabbix_problem_list',
    description: 'List active Zabbix problems for a host group.',
    parameters: {
      group: { type: 'string', required: true },
      limit: { type: 'integer', default: 100, max: 500 },
    },
    output: { schema: { type: 'array', items: { type: 'object' } }, render: ... },
    async execute(args, exec) {
      const secret = await ctx.credentials.resolve(credentialRef(config.credentialRef))
      // 只读；失败码映射 AUTH_FAILED / RATE_LIMITED / UPSTREAM_ERROR
    },
  }))
}
```

### 6.4 会话、事件与审计

- 会话事实以 dsh 的 JSONL 为准；平台保存 `session_id / tenant / user / scenario / runtime / created_at` 索引。
- Web 实时流：平台把 dsh `session.event` 转成自己的事件协议（`tool.started`、`tool.finished`、`approval.requested` 等），不直接暴露 dsh 内部格式。
- 工具调用审计：平台侧记录 `tenant_id`、`user_id`、`session_id`、`connector`、`action`、`risk`、`params_hash`、`approval_id`、`result_status`、`elapsed_ms`、`egress_ip`；不记录明文凭据。
- 审计只追加，保留 ≥ 180 天，可按租户导出；平台管理员默认只看元数据。

### 6.5 升级与回归

| 风险 | 措施 |
|---|---|
| dsh API pre-stable | 只依赖 SDK 协议、`defineTool`、`ctx.tools`、`ctx.credentials` 等明确面 |
| 会话格式升级 | 升级前跑旧会话只读打开 + resume 回归；保留上一版镜像回滚 |
| 工具插件破坏 | 自定义插件单独版本化；运行时镜像与插件版本绑定 |
| 模型协议变化 | 模型网关做协议适配层；pi-ai 升级前跑流式/工具调用回归 |

---

### 6.6 Commander：从单会话到事件指挥

“Commander”是 OpsAgent 的事件指挥落地名，不是更大的模型：**一个指挥智能体 + 一组专业队友 + Incident/Ticket 任务板 + Evidence 证据板 + Approval 审批**。它建立在 dsh 能力与 dsh-superagent 的编排骨架上。

| dsh 能力 | 在运维场景中的用法 |
|---|---|
| `subagent`（fresh / fork / out-of-process） | 指挥智能体按需派出指标、日志、DBA、K8s、网络、变更等专业队友 |
| Agent Teams（experimental：Lead/teammates、直接消息、共享任务板、DAG、writeScopes、wait/steer） | 事件期间维护 durable roster 与任务板；队友可被追问、打断、交接 |
| `workflow` | 把稳定的检查步骤写成确定性 fan-out 脚本（如巡检的 20 个检查项） |
| `goal` + 会话持久化 | 长时间事件跨班次持续；交接时恢复上下文与任务板 |
| `compaction` + `skills` | 长日志压缩；把 Runbook/变更手册作为 skill 按需加载 |
| 审批/沙箱 | 所有 R2+ 动作仍然走平台审批，指挥智能体不能绕过 |

**一次事件指挥的流程**

```
告警/事件进入
  → 指挥智能体（Lead）读取租户、角色、连接器、知识
  → 建任务板：定位范围 / 取证 / 假设 / 验证 / 缓解 / 复盘
  → 按角色派队友（3–6 个），每个队友拿独立工具集与证据要求
  → 并行取证：指标、日志、DB 会话、K8s 事件、变更记录、历史知识
  → 证据板去重、标注来源/时间/置信度
  → 指挥智能体合并假设，逐条排除，输出 Top3 根因
  → 需处置：生成 R2 动作清单 → 人工/企业微信审批 → 执行/拒绝
  → 交接：任务板、证据、未决问题、下一步；跨班次可恢复
  → 复盘：时间线 + 根因 + 处置 + 证据 → 知识草稿 → 知识管理员审核
```

**边界与护栏**

- 队友数量 3–8、任务数 ≤ 32、单事件 Token/时长预算可配；超限暂停并转人工。
- 队友只能使用会话 capability token 允许的工具；不能因为“指挥”获得额外权限。
- 每个结论必须引用至少 2 条独立证据；没有证据的假设只作为“待验证”。
- R2/R3 动作必须由人确认；企业微信/Web 审批都写入同一审批单。
- 任务板 `writeScopes` 提示资源冲突；不把它当锁，但高危动作按资源串行。
- 支持“人工接管/移交”：人可以在任意步骤暂停队友、修改任务、接管会话。
- 全部队友消息、任务变更、工具调用、审批进入审计；不进入模型历史的内容只进日志。

**落地节奏**

- **P1**：不建 Commander；只做诊断会话/报告与审批基础，为 P1.6 准备。
- **P1.6**：选择性 fork/裁剪 dsh-superagent，做 connector-only Commander；Incident/Evidence/Hypothesis/Approval；Alert/Agent Source；ConnectorExecutor；OpsAgent Web 原生事件指挥台；无 shell。
- **P2-B**：接 HostAgentExecutor，补客户端 Agent 调度与完整根因闭环。
- **P2**：dsh Agent Teams 稳定后再评估接入，不把 experimental 作为 P1.6 依赖。
- **不建议**：让指挥智能体自由写 SQL/任意 shell；Commander 的价值是编排、证据和审批，不是扩大权限。

原型：`design/incident.html`（事件指挥台：任务板、队友、证据、审批）；Commander 事件列表页待补。

实现参考：`docs/design/research/dsh-superagent-feasibility.md`。结论是**选择性 fork/裁剪** dsh-superagent 的编排/授权/派工/持久化骨架，新增 Incident/Evidence/Approval、HostAgentExecutor/ConnectorExecutor、运维 Source/Channel；不建议直接作为 bundle 接入，也不保留其无审批 worker shell。

### 6.7 长任务与无人值守巡检

长任务不是“一个会话一直挂着”，而是平台里的**持久化任务实体**：有状态、检查点、心跳、预算和恢复能力。它解决无人值守巡检、平台健康检查、容量采集、批量核查等场景。

**任务模型**

```yaml
id: task_9f21
tenant: t-1001
type: unattended_inspection      # unattended_inspection | platform_health | capacity_scan | compliance_check
trigger: { kind: schedule, cron: "*/30 * * * *", window: "07:00-19:00" }
scope: { platform: self, systems: [order, pay], connectors: [zabbix-prod, prom] }
status: running                  # queued | running | waiting_approval | paused | succeeded | failed | cancelled
budget: { maxDurationSec: 14400, maxTokens: 300000, maxToolCalls: 200 }
heartbeat: { intervalSec: 30, leaseTimeoutSec: 120 }
checkpoints: [scope_resolved, metrics_collected, anomalies_triaged, report_ready]
alertPolicy: { on: [critical, high], channels: [wecom, email, webhook], dedupeWindowSec: 900 }
```

**执行机制**

- 平台 scheduler 按 cron/手动触发创建任务；Worker 领取并启动租户 runtime 的 agent 会话（`subagent`/`workflow`），任务实体与 dsh 会话分离。
- 每个阶段写 checkpoint；Worker 记录心跳与租约。runtime 崩溃/超时后从最近 checkpoint 恢复，不从头重跑；超过租约重新排队。
- 任务有硬预算：最大时长、Token、工具调用、并发数；超限暂停并通知，不无限消耗。
- 只读任务默认无人值守；任何 R2+ 动作仍进入审批，不在长任务里自动执行。
- 取消/暂停/接管由人工触发；取消后保留检查点与部分产物，便于审计。

**无人值守巡检：平台 + 系统健康**

```
调度触发
  → 平台健康：控制面/运行时/DB/Redis/队列/对象存储/证书/连接器/消息渠道
  → 租户系统：主机、数据库、中间件、容器、监控告警
  → 异常规则：阈值/基线/连续次数/变化率
  → 分级：critical/high → 消息中心推送（企业微信/邮件/Webhook）
  → 严重异常可自动创建事件（Commander 接管），不自动修复
  → 生成巡检结论、证据、趋势；有价值内容生成知识草稿
```

- 平台健康巡检只对平台管理员/平台运维可见，不暴露租户业务数据。
- 租户巡检结果按租户隔离；异常触发告警、值班路由、升级；重复告警按窗口抑制。
- 长任务结果写入产物库，可被报告/知识/事件引用。

**护栏**

- 并发上限、每租户配额、维护窗口、静默期、失败退避。
- 告警去重/抑制/升级；避免告警风暴。
- 任务心跳丢失告警；运行时不可用时任务进入 `paused`，不假成功。
- 任务全部动作审计：创建、领取、检查点、告警、暂停、恢复、取消、产物。

**UI**

原型：`design/tasks.html`（长任务中心：运行中/计划中/历史任务、进度、检查点、心跳、预算、告警、暂停/恢复/取消、人工接管；无人值守巡检详情展示平台健康与系统健康分组）。

**与 dsh 的关系**

- 触发与持久化由平台 worker/任务实体负责；dsh `schedule`/`jobs` 可用于会话内定时/后台工作。
- Agent 执行使用 dsh subagent/workflow；长任务检查点由平台在 session.event 上打点，保证跨进程恢复。
- 长任务不依赖“会话进程永活”；不把任务状态只放在内存里。

## 7. 模型接入

### 7.1 两种接口，一个网关

| Provider 类型 | 协议 | 鉴权 | 用途 |
|---|---|---|---|
| OpenAI 兼容 | `/v1/chat/completions`、`/v1/responses` | API Key / Bearer / 自定义 Header | DeepSeek、vLLM、OneAPI、企业网关 |
| Anthropic | Messages API（`/v1/messages`） | `x-api-key` + `anthropic-version` | Claude 长上下文/复杂分析 |
| 私有网关 | OpenAI 兼容（最常见） | 网关自己的 token | 私有化客户统一入口 |

dsh 的 `llm-pi-ai` 已覆盖 `openai-completions`、`openai-responses`、`anthropic-messages`，平台不需要为每种模型写适配器；只有私有 gRPC/非 HTTP 协议才需要自定义 adapter。

### 7.2 平台模型网关职责

- **Provider 注册**：名称、协议、baseURL、模型清单、上下文窗口、最大输出、reasoning effort、超时、重试。
- **租户策略**：租户可用模型白名单、默认模型、禁止的模型、Token 月预算、并发上限。
- **路由**：`fast`（日报、简单问答）/ `reasoning`（根因、容量）/ `long-context`（长日志、报告），支持回退顺序。
- **密钥**：平台级 Provider 由平台 KMS 托管；租户 BYOK 用租户级信封加密；运行时按请求取短时密钥，不落 `DSH_HOME`。
- **可观测**：请求量、Token、P95、错误码（`AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`）、租户用量。
- **数据边界**：模型调用只发脱敏后的摘要；原始日志/主机名/凭据按租户策略脱敏；禁止把凭据放入 prompt。

### 7.3 配置示意（dsh `llm-pi-ai`）

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ops-openai:
        displayName: 企业 OpenAI 兼容网关
        api: openai-completions          # 或 openai-responses
        baseURL: https://llm.corp/v1
        apiKeyEnv: OPS_LLM_KEY           # 运行时由平台注入短时值
        models:
          - id: deepseek-v3
            name: DeepSeek V3
            contextWindow: 131072
            maxTokens: 8192
      ops-anthropic:
        displayName: Anthropic Claude
        api: anthropic-messages
        baseURL: https://api.anthropic.com
        apiKeyEnv: OPS_ANTHROPIC_KEY
        models:
          - id: claude-sonnet-4-5
            name: Claude Sonnet 4.5
            contextWindow: 200000
            maxTokens: 64000
```

### 7.4 待确认

- 默认是**平台统一 Key**（客户无需自备）还是**租户 BYOK**？建议两者都支持，默认平台 Key + 租户可覆盖。
- 是否需要“模型路由策略”在首期可配置，还是先固定 2 条路由？

---

## 8. 连接器与插件体系

### 8.1 接入方式与插件类型

| 方式 | 适合 | 用户操作 | 审核 |
|---|---|---|---|
| 标准连接器 | Zabbix、Prometheus、Grafana、Alertmanager、ClickHouse、MySQL、PostgreSQL、Redis、SSH、K8s、Kafka、Elasticsearch | 选类型 → 填地址/凭据 → 测试 → 授权角色 | 租户管理员直接启用 |
| 通用 HTTP | 有 REST/JSON API 的长尾平台 | 填 baseURL、请求模板、JSONPath 映射、测试用例 | 租户管理员审核 |
| AI 创造模式 | 非标商业平台、SOAP/gRPC、私有签名 | 描述目标 → dsh cordis 生成 bundle → 沙箱安装/inspect → 租户管理员审核 | 租户管理员；平台共享由租户管理员审核 |
| MCP | 已有 MCP server 的平台 | 注册 server（平台白名单）→ 发现工具 | 平台管理员登记 |
| 消息渠道插件 | 企业微信（私有部署）、邮件、Webhook | 选渠道 → 填凭据/回调 → 绑定用户 | 租户管理员；企业微信按插件启用 |

> 判定原则：**能用 YAML 表达的绝不用代码；必须用代码的，代码进沙箱、进审核、进版本库。**

**首期连接器包**

| 批次 | 连接器 |
|---|---|
| **P1**（标准包） | Zabbix、Prometheus、Grafana、Alertmanager、ClickHouse、MySQL、PostgreSQL、Redis、SSH |
| **P1.5** | Kubernetes、Kafka、Elasticsearch/OpenSearch、MongoDB、Nginx、RabbitMQ |
| **P2** | AWX/Ansible、CMDB/ITSM、云监控、网络设备（SNMP）、VictoriaMetrics、Loki |
| 长尾 | 通用 HTTP 连接器 + AI 创造模式 |

> 数据库连接器默认只读账号 + 参数化查询模板（状态、慢查询、锁、复制、容量）；临时只读 SQL 需单独授权与审批，不允许拼接用户输入。

ClickHouse 作为分析库连接器：走 HTTP 接口，只读账号，强制 `max_execution_time`、`max_result_rows`、`max_result_bytes`；查询模板参数化，支持把指标/日志结果沉淀到数据集，供指标基线与日志模式类知识钻取。

### 8.2 连接器 manifest（摘要）

```yaml
apiVersion: connector.ops/v1
kind: Connector
metadata:
  id: zabbix-prod
  name: Zabbix 生产监控
  vendor: Zabbix
  version: 1.4.0
  source: builtin           # builtin | community | ai-generated | custom-code
spec:
  type: zabbix              # http|promql|zabbix|jsonrpc|ssh|snmp|kubernetes|custom
  transport:
    baseUrl: https://zabbix-prod.corp
    apiPath: /api_jsonrpc.php
    timeoutMs: 15000
    proxy: { mode: platform-egress, allowlistRef: wl-zbx-prod }
  auth:
    scheme: api_key
    credentialRef: cred/t-1001/zabbix-prod
    placement: header
    headerName: Authorization
    valueTemplate: "Bearer {{secret}}"
  capabilities:
    read: [host.list, problem.list, history.query]
    write: [problem.ack]
    riskMax: R1
    dataClasses: [infra.metric, infra.inventory]
  actions:
    - id: problem.list
      toolName: zabbix_problem_list
      risk: R0
      inputSchema: { type: object, additionalProperties: false, ... }
      response: { rows: "$.result[*]", fields: { ... } }
      render: { hint: table, title: 活跃告警 }
  healthCheck: { intervalSec: 60, probe: { rpcMethod: apiinfo.version } }
  tests: [ ... 至少 3 条，含鉴权失败/空结果/上游 5xx ]
  redaction: { paths: ["$.result[*].password"], patterns: ["(?i)authorization:\\s*\\S+"] }
  governance: { visibility: tenant-role-groups, allowedRoles: [sre, ops-duty] }
```

完整字段与 Zabbix 示例见 `docs/design/research/ops-connectors-and-scenarios.md` 第 2–3 节。

### 8.3 统一工具契约

**命名**：`{connector}_{noun}_{verb}`，全小写 snake_case，≤ 40 字符，动词受控（get/list/query/search/describe/count/create/update/delete/ack/silence/restart/scale/cordon/run/render）。

**输入信封**：

```json
{
  "required": ["params"],
  "params": { "type": "object" },
  "scope": { "tenant": "string", "targets": ["string"], "timeRange": { "from": "date-time", "to": "date-time", "window": "1h" } },
  "options": { "limit": 200, "dryRun": false, "renderHint": "table" },
  "idempotencyKey": "32-64 hex",
  "approval": { "required": false, "ticketId": null }
}
```

**输出信封**：

```json
{
  "tool": "zabbix_problem_list",
  "connector": "zabbix-prod",
  "ok": true,
  "risk": "R0",
  "data": { "rows": [], "count": 13, "truncated": false },
  "meta": { "traceId": "tr_9f2c", "elapsedMs": 812, "partial": false, "source": "https://...",
            "dataSource": "local", "asOf": "2026-11-03T12:40:00+08:00", "stale": false, "fallbackReason": null },
  "render": { "hint": "table", "title": "活跃告警（13）", "columns": ["host", "severity", "age"] },
  "audit": { "tenant": "t-1001", "actor": "user:chen", "approvalId": null, "credentialRef": "cred/t-1001/zabbix-prod", "paramsHash": "sha256:..." }
}
```

**约束**：`additionalProperties: false`；写操作必带 `idempotencyKey`；R1/R2 必须支持 `dryRun`；失败同信封 `ok=false`，错误码可路由。

### 8.4 风险分级与审批

| 级别 | 定义 | 例子 | 默认策略 |
|---|---|---|---|
| **R0 只读** | 纯查询 | 主机清单、PromQL、日志检索 | 自动执行 |
| **R1 低危写** | 可逆、单对象 | 告警确认、静默、建工单、cordon | 自动（生产可配一人确认） |
| **R2 高危写** | 影响可用性/多对象 | 重启服务、滚动重启、scale、drain、删 Pod | 强制审批（生产双人） |
| **R3 禁止** | 不可逆/越权面过大 | 任意 shell、批量删除、改 RBAC、改计费 | 默认禁用；白名单 + 双人 |

**审批矩阵**：dev R0–R2 免审、R3 双人；staging R0/R1 免审、R2 一人、R3 双人；**prod R0 免审、R1 可配一人、R2 双人、R3 禁止（白名单例外）**。  
补充：R1 影响对象 > 5 自动升级；变更冻结期 R2 一律拒绝；`dryRun=true` 且 diff 为空可直接执行；**租户策略只能加严不能放宽**。

### 8.5 生命周期

```
draft → testing → pending_review → published → deprecated
  ↑          │            │
  └──────────┴────────────┘（测试/审核失败退回）
```

- **draft**：租户管理员创建，仅自己可见。
- **testing**：健康检查 + 契约测试 + 真实只读测试。
- **pending_review**：租户管理员审核能力、风险、数据范围。
- **published**：租户目录可见；角色按授权使用。
- **deprecated**：有新版本或依赖失效；已装实例只读，保留 90 天。

### 8.6 角色权限分配

租户管理员在“连接器 → 权限分配”里按 **连接器实例 × 能力 × 角色** 授权：

| 角色 | 只读工具 | 低危写 | 高危写 | 数据范围 |
|---|---|---|---|---|
| 值班 SRE | ✅ | 告警确认（需审批） | ❌ | 全部主机 |
| DBA | ✅ | ❌ | ❌ | 数据库分组 |
| 容器平台 | ✅ | ❌ | scale/restart（双人） | K8s 相关 |
| 只读观察者 | 仅报告/指标 | ❌ | ❌ | 全部只读 |

- 工具执行时做**双重校验**：控制面授权 + 运行时 capability token；场景分享不放大权限。
- 授权变更写审计；正在运行的会话使用启动时快照，新会话生效。

---

## 9. 场景与分享

### 8.7 插件数据沉淀（Plugin Data Store）

对端平台的数据不能每次都实时拉：接口慢、限流、历史查询窗口有限、跨网不稳定。插件需要把对端数据**沉淀到本平台**，并且平台查询时**本地优先、对端兜底**。

**设计原则**

1. **插件声明，平台建库**：插件只能用声明式 schema 描述数据集，平台校验后自动建表/建索引；生成插件不能执行任意 DDL。
2. **租户隔离**：每个租户、每个插件实例独立命名空间；跨租户查询直接拒绝。
3. **读本地优先，写永远实时**：读查询优先本地新鲜数据；本地过期/缺失回源；写动作必须实时到对端并审批。
4. **可解释**：每次工具结果标注 `source=local|live|mixed`、`asOf`、`stale`、`fallbackReason`，模型和人都知道数据来自哪里。
5. **自动清理**：按 TTL、行数、字节配额、分区老化自动清理；清理可审计、可 dry-run。

**manifest 中的 storage 段**

```yaml
spec:
  storage:
    enabled: true
    quota: { maxBytes: 5GB }
    datasets:
      - name: hosts
        schema:
          primaryKey: [hostid]
          columns:
            hostid: { type: string, required: true }
            host:   { type: string, index: true }
            ip:     { type: string }
            status: { type: enum, values: [enabled, disabled] }
            groups: { type: string[] }
            updatedAt: { type: datetime }
        sync:
          action: host.list          # 复用连接器能力，不另写代码
          mode: incremental          # full | incremental
          watermark: clock           # clock | updatedAt | cursor
          intervalSec: 300
          fullReconcileEvery: 1d
        retention:
          maxAgeDays: 30
          maxRows: 2000000
          staleAfterSec: 600         # 超过即视为过期，查询回源
        queryPolicy: local_first     # local_first | live_first | local_only | live_only
        writeBack: true              # 实时查询结果是否回写
```

**自动建库**

- 控制面按 `dataset.schema` 生成租户内逻辑表（如 `tenant_<id>.plugin_<instance>_<dataset>`），或统一表 + `dataset_id` 分区；两种实现都要带 `tenant_id`、`plugin_instance_id`、`dataset_id`。
- 这就是“插件自动创建插件数据库”：每个插件实例获得独立命名空间，平台负责 DDL、迁移、索引与配额，插件只声明 schema。
- 迁移：schema 版本化；加列允许，删列/改类型走显式迁移和回填；失败回滚。
- 索引：主键唯一；高频过滤列建索引；大文本/附件放 MinIO，表只存引用。
- 配额：每数据集行数/字节；租户总配额；超限拒绝同步并告警，不静默丢数据。

**同步与回源**

- Worker 按 `sync.intervalSec` 拉取；incremental 用水位；每 `fullReconcileEvery` 做一次全量对账，处理删除/改名。
- 幂等 upsert；失败指数退避；连续失败置 dataset degraded，并通知消息中心。
- 查询工具按 `queryPolicy` 决策：
  - `local_first`：本地 fresh → 本地；stale/miss → 对端 → 回写（如允许）。
  - `live_first`：先对端，失败再本地；适合强实时动作前的确认。
  - `local_only`：只读本地；用于离线/隔离环境。
  - `live_only`：只读对端；用于不允许落地的敏感数据。
- 写动作（R1+）永远走对端，不写本地“成功”；本地只记录审计与结果摘要。
- 结果信封增加：

```json
{
  "dataSource": "local",
  "asOf": "2026-11-03T12:40:00+08:00",
  "stale": false,
  "fallbackReason": null,
  "coverage": { "matched": 1284, "syncedAt": "..." }
}
```

**自动清理**

- 每个数据集独立的 `retention`：按 `maxAgeDays` 删除旧行、按 `maxRows` 保留最新 N 行、按 `maxBytes` 配额驱逐最旧数据。
- 清理任务：每日/每小时；按分区 drop 优先，避免大表 delete；清理后 `ANALYZE/VACUUM`。
- 清理前 dry-run 报告影响行数/字节；清理结果写审计；失败告警。
- Knowledge/审计/审批数据不在此清理范围；由各自保留策略管理。

**UI**

`design/data-store.html`：数据集、行数/大小、最后同步、新鲜度、同步策略、查询优先、保留/清理、存储配额、最近清理记录、立即同步/回源测试。知识智能体可以按调度消费这些数据集，生成基线/拓扑/模式类知识草稿（见 9.6）。

### 8.8 消息中心与渠道插件

消息中心是平台统一的通知与审批入口；**企业微信是默认渠道**，支持私有部署；企业微信对接本身也是一个插件。

**消息中心职责**

- 统一消息模型：`event → template → route → channel → delivery`。
- 消息类型：审批请求/结果、事件升级、巡检报告、知识待审、连接器健康、安全告警、系统通知。
- 路由：按租户、角色、值班表、场景、静默时段；支持升级（15 分钟未处理 → 备班/主管）。
- 渠道：站内信（默认）、企业微信（默认外部渠道，支持私有部署）、邮件、Webhook。
- 投递记录：状态、重试、回执、失败原因；幂等去重；审批动作回写。

**企业微信渠道插件**

```yaml
kind: Channel
metadata: { id: wecom-corp, name: 企业微信（私有部署） }
spec:
  type: wecom
  endpoint: https://qyapi.weixin.qq.com   # 私有部署填自己的网关
  corpIdRef: cred/t-1001/wecom-corp-id
  agentIdRef: cred/t-1001/wecom-agent-id
  secretRef: cred/t-1001/wecom-secret
  callback:
    tokenRef: cred/t-1001/wecom-token
    aesKeyRef: cred/t-1001/wecom-aes-key
  capabilities: [text, markdown, template_card, callback_action]
  userMapping: { mode: oauth | manual | ldap_attr, attribute: wecom_userid }
  allowlist: { departments: [ops], users: [] }
```

- 出站：文本/Markdown/模板卡片（审批卡片带“通过/拒绝/查看”）；限流与重试；内容脱敏。
- 入站：企业微信回调验签、AES 解密、防重放；审批动作校验审批单状态与用户绑定；幂等更新；写审计。
- 私有部署：base URL 可配；证书校验；只允许白名单出口；不把 secret 写日志。
- 用户绑定：企业微信 userid ↔ 平台用户；首次 OAuth/扫码或管理员映射；换绑需审计。
- 默认策略：租户未配置企业微信时只发站内信；配置后审批/事件默认走企业微信，站内信保留。

**UI**

`design/messages.html`：收件箱、审批卡片、事件/巡检/知识待审、渠道状态、企业微信绑定、模板、投递记录与重试。

### 9.1 场景 DSL（摘要）

```yaml
id: inspection.daily.v1
version: 2.1.0
title: 日常巡检
inputs:
  - { key: scope, type: string, required: true, label: 巡检范围 }
  - { key: window, type: duration, default: 24h, label: 时间窗 }
  - { key: profile, type: enum, options: [default, strict], default: default }
steps:
  - { id: inv, kind: tool, ref: zabbix_host_list, with: { group: "{{input.scope}}" } }
  - { id: met, kind: tool, ref: prom_metric_query_range, with: { targets: "{{steps.inv.rows}}", window: "{{input.window}}" } }
  - { id: kb, kind: tool, ref: knowledge.search, with: { query: "巡检 {{input.scope}} 基线", limit: 5 } }
  - { id: ana, kind: agent, ref: analyzer, with: { metrics: "{{steps.met.data}}", knowledge: "{{steps.kb.data}}" } }
  - { id: rep, kind: agent, ref: reporter, with: { findings: "{{steps.ana.output}}" } }
tools: [zabbix_host_list, prom_metric_query_range, knowledge.search]
agents:
  - { role: analyzer, model: reasoning, promptRef: prompts/analyzer.md, maxSteps: 8 }
  - { role: reporter, model: fast, promptRef: prompts/report.md, maxSteps: 3 }
guards: { riskMax: R0, requireApproval: false, maxDurationSec: 300, maxToolCalls: 40 }
outputs: [{ type: report, templateRef: templates/inspection.md, format: [md, pdf] }]
knowledgeRefs: [kb.inspection.baseline, kb.runbook.mysql-pool]
notify: { channels: [wecom], on: [finish, failure], roles: [sre-duty] }
postActions: [{ type: knowledge.draft, from: outputs, minConfidence: 0.7 }]
permissions: { connectorTypes: [zabbix, promql], dataClasses: [infra.metric], writeActions: [], storage: read }
visibility: { scope: roles, roles: [sre, ops-duty] }
tests:
  - { name: 空范围优雅失败, input: { scope: "__none__" }, expect: { status: empty, noWrite: true } }
```

### 9.2 首期场景库

| 场景 | 触发 | 最高风险 | 产物 | 首期 |
|---|---|---|---|---|
| 日常巡检 | 定时/手动 | R0 | 巡检报告 + findings | ✅ |
| 指标异常分析 | 告警/手动 | R0 | 分析报告 + 图表 | ✅ |
| 告警根因分析 | 告警事件 | R1 | RCA + Top3 + 证据链 | ✅ |
| 故障诊断 | 人工/值班 | R1 | 诊断记录 + 建议 | ✅ |
| 容量与成本 | 周/月 | R0 | 容量报告 + 优化清单 | P2 |
| 变更风险评估 | 变更单 | R1 | 风险评分 + 回滚预案 | P2 |
| 日志排查 | 人工/告警 | R0 | 日志证据包 | P2 |
| 资产配置核查 | 每日 | R0 | 差异清单 | P2 |
| 日报/周报 | 定时 | R0 | MD/PDF | P2 |

### 9.3 可见性模型

| 级别 | 谁能用 | 进入方式 |
|---|---|---|
| **个人（draft）** | 创建者 | 新建默认 |
| **角色** | 创建者所在角色 | 发布默认（tests 通过 + 权限自检） |
| **租户共享** | 本租户全部角色 | 创建者申请 → 租户管理员审批 |
| **平台共享** | 其他租户可安装 | 租户管理员审核 → 进入平台目录 → 其他租户安装；平台管理员只做目录治理/下架 |

> 已确认：平台级分享由**租户管理员审核**即可进入平台目录；平台管理员不设审批前置，只负责目录治理、合规下架和平台级审计。审批仍只能收窄权限。

### 9.4 分享状态机

```
draft ─发布(租户内)─▶ tenant_published ─申请分享─▶ share_pending
  ▲                        │                          │
  │                        │                    租户管理员审批
  │                        │                          ▼
  │                        └──────────────▶ platform_published
  │                                                   │
  └──── revoked ◀─────────┘               驳回 ▶ share_rejected
```

| 状态 | 谁能操作 | 效果 |
|---|---|---|
| `draft` | 创建者 | 仅自己可见，可测试 |
| `tenant_published` | 创建者 | 默认角色可用 |
| `share_pending` | 创建者 / 租户管理员 | 冻结版本，等待审批 |
| `platform_published` | 租户管理员审核后 | 进入平台目录，其他租户可安装 |
| `share_rejected` | 租户管理员 | 附理由，退回 tenant_published |
| `revoked` / `deprecated` | 创建者/租户管理员/平台管理员 | 已装实例通知只读；平台管理员可合规下架 |

**硬规则**：分享审批只能收窄权限（riskMax、写动作、数据分级）；安装是“复制 + 绑定”，独立演进；平台级场景必须声明 dataClasses 与外部依赖，安装时逐项确认。

### 9.5 发布门禁

- 至少 3 条测试，含正常、鉴权失败、空结果；缺一不许发布。
- `inputSchema` 必须 `additionalProperties: false`；读动作有 rows 映射与字段类型。
- 错误映射覆盖 401/403/404/429/5xx；分页正确。
- 脱敏命中测试（Authorization、password、AK/SK）。
- 健康检查 < 2s 且不产生写。
- 文档含能力清单、权限需求、已知限制。

---

### 9.6 知识管理（运维知识沉淀）

运维过程产生的大量数据（告警、指标、日志、会话、巡检、变更、处置）本身不是知识。平台需要把它们加工成**可复用、可引用、可审核、租户内共享**的运维知识。

**知识类型**

| 类型 | 例子 | 主要来源 |
|---|---|---|
| 故障案例 | “订单库连接池耗尽 → 5xx” | 用户对话 / 平台运行 |
| Runbook | “MySQL 连接数告警处理步骤” | 知识文档 / 平台运行 |
| 拓扑与依赖 | “交易链路依赖 order-db-01” | 插件数据（CMDB/连接器） |
| 指标基线 | “order-service 5xx 日间基线 0.2%” | 插件数据 / 平台运行 |
| 变更手册 | “K8s 节点磁盘清理变更步骤” | 知识文档 / 平台运行 |
| FAQ / 规则 | “为什么 Zabbix 告警会重复” | 知识文档 / 用户对话 |

**四类知识来源**

| 来源 | 输入 | 知识智能体做什么 | 典型产出 | 边界 / 审核 |
|---|---|---|---|---|
| **插件数据** | 插件数据集、连接器只读工具、CMDB/监控快照 | 每日增量 + 每周深度钻取：基线、共变、异常模式、拓扑、重复告警；采样/聚合后抽取 | 指标基线、依赖拓扑、故障模式、资产规则 | 只读；引用数据集/快照；不导出原始明细；数据清理后知识保留但证据标注“快照已过期” |
| **知识文档** | PDF / Word / Excel / Markdown / HTML（含 CSV 等表格文件） | 解析、切片、embedding、抽取步骤/前置条件/回滚/验证；Excel 按表结构抽取 | Runbook、FAQ、变更手册、规范、参数基线 | 继承文档 ACL；文档版本/删除同步；不得含凭据；人工审核 |
| **用户对话** | 租户内已完成的会话、事件指挥记录 | **租户统一开启**后，脱敏并抽取“症状 → 根因 → 处置 → 验证”；关联证据 | 故障案例、经验、排障路径 | 租户级开关；员工隐私告知；不把原对话写入知识；知识管理员审核 |
| **平台运行** | 巡检报告、场景产物、事件时间线、智能体产物 | 读取结构化报告与证据，抽取结论、适用条件和复现步骤 | 故障案例、基线、巡检规则、处置建议 | 只引用已生成的产物；自动草稿；人工审核 |

> “学习”指抽取、结构化、向量化与检索，不是把租户数据训练进共享模型。P2 如要做模型微调，需单独授权并使用租户级模型。

默认采信顺序（可按知识类型覆盖、由知识管理员裁决）：**规范文档 ≈ 平台运行事实 > 插件数据派生 > 用户对话经验**。冲突时保留各方证据，不静默覆盖。

**知识模型**

```yaml
id: kb.fault.order-db-pool
tenantId: t-1001
type: fault_case
title: 订单库连接池耗尽导致 5xx
status: published            # draft | pending_review | published | needs_update | superseded | archived
version: 3
summary: ...
symptoms: [5xx, connections_92%, wait_queue]
rootCause: ...
resolution: ...
applicability: { services: [order], env: prod, versions: ... }
sourceType: platform_run        # plugin_data | document | conversation | platform_run
sourceRef: run_2041 / report_2041 / session_8f2a
sourceVersion: 2026-11-03
sourceAcl: role:sre-duty        # 来源允许的最宽范围
extractionRunId: ke_7741
evidence: [session:..., report:..., tool:...]
confidence: 0.86
sourceHash: ...
owner: user:chen
reviewer: user:lin
reviewedAt: ...
nextReviewAt: ...
```

**知识生成流程**

```
四类来源分别进入采集适配器：
  plugin_data    → 每日增量 + 每周深度钻取数据集 → 候选事实（基线/拓扑/模式）
  document       → 上传 → 解析/切片/embedding → 候选事实
  conversation   → 租户统一开启 → 完成会话 → 脱敏 → 候选事实
  platform_run   → 巡检/场景/事件产物 → 候选事实

  → 知识智能体统一抽取（症状/根因/步骤/适用/证据/置信度）
  → 去重（embedding + 事实指纹）、冲突检测、质量门禁
  → 生成 draft
  → 知识待审队列 → 知识管理员审核/补充/退回
  → published（租户内共享；按角色/来源 ACL 收窄）
  → knowledge.search 引用；反馈“有效/无效”
  → 到期复审 / 来源更新 / 被新版本取代 → needs_update / superseded
```

**来源特有规则**

- **插件数据**：只读、按预算采样；每日增量、每周深度钻取；结论必须引用数据集与快照时间；不得把原始日志/主机明细直接写进知识正文。
- **知识文档**：支持 PDF / Word / Excel / Markdown / HTML 及 CSV 等常见格式；保留文档版本与锚点；文档删除/改版时标记 `needs_update`；文档权限比知识更严时，知识继承更严范围。
- **用户对话**：由**租户管理员统一开启**，不做逐会话授权；开启后对租户内已完成的会话生效，关闭后停止新抽取、已有知识保留并进入复审；抽取前脱敏，知识正文不保存原始对话；证据链接按查看者权限裁剪；员工隐私告知与审计必须保留。
- **平台运行**：优先使用已生成的巡检报告、事件时间线、场景产物；引用产物 ID，不重新推断原始工具结果。
- **来源 ACL**：知识发布范围不能宽于最严来源 ACL；需要扩大时，由知识管理员补充独立证据后重新审批。

**对话沉淀的租户开关**

- 租户设置中新增 `knowledge.conversation.enabled`，默认关闭；开启后由租户管理员确认隐私告知与审计策略。
- 开启只影响**之后完成**的会话；正在进行/历史会话不自动回溯。历史抽取由租户管理员显式发起，可选最近 30 天 / 90 天 / 自定义范围，单独审计、脱敏、只生成草稿。
- 关闭立即停止新抽取；已发布知识保留，但进入复审队列，知识管理员可标记 `needs_update` 或归档。
- 对话来源的知识必须经过知识管理员审核；不允许自动发布。
- 用户可在隐私说明中看到“会话会用于知识沉淀”，但不提供逐会话开关（按本轮确认）。

**知识智能体**

- 一个独立 agent preset（`knowledge`），不参与值班会话；可由 worker 批量调度，也可在事件结束时触发。
- 工具：只读数据集查询、文档解析/切片、会话读取（租户开关下）、`knowledge.search`（查重）、embedding、证据快照。
- 输出严格 JSON：`type/title/summary/symptoms/rootCause/resolution/applicability/evidence/confidence/sourceRef`；不输出 Markdown 以外的可执行内容。
- **不能发布、不能改权限、不能执行连接器写操作**；只能生成 `draft` 与 `extractionRun` 记录。
- 幂等：以 `sourceHash + sourceVersion + extractorVersion` 去重；来源更新时重跑，产生新草稿并关联旧版本。
- 预算：单次抽取限时/限 Token；大批量文档按队列分批；失败重试并告警。
- 抽取运行记录保留：谁触发、读了哪些来源、模型、提示词版本、耗时、输出哈希、审核结果。

**文档接入**

- 支持上传 PDF / Word / Excel / Markdown / HTML / CSV 等常见格式；病毒扫描、解析、OCR（可选）、切片、embedding。本期只做本地上传，外部文档平台不在本期范围。
- 文档版本、作者、ACL 一并入库；删除文档时知识置 `needs_update`，不立即删除已发布知识。
- 同一文档重复上传按内容哈希去重；大文件分片入库，知识正文只保留摘要与锚点。

**审核规则**

- **AI 永不自动发布**：自动沉淀只生成 `draft`；变更/新增/归档都必须由知识管理员确认。
- 审核检查：证据是否可追溯、适用范围是否明确、是否含凭据/客户数据、是否与现有知识冲突、是否有可执行步骤。
- 修改已发布知识 → 创建新版本，状态 `pending_review`；旧版本继续可用直到新版本发布。
- 审核通过/驳回都写审计；通知消息中心（企业微信卡片可直达）。
- 知识管理员是职能角色，可由普通成员担任；租户管理员可兼任。

**租户隔离与共享**

- 知识表带 `tenant_id`，PostgreSQL RLS；向量索引也按租户分区/过滤。
- 知识默认**租户内共享**，可按角色/数据范围收窄；不跨租户，不进入平台市场。
- 导出的知识包必须经过权限校验并写审计；离线交付需租户管理员确认。
- 知识引用只返回有权限的片段；不把其他角色/团队的数据带出。

**Agent 使用**

- 新增工具 `knowledge.search` / `knowledge.get` / `knowledge.cite`，参数带 `query/tags/service/env/limit`。
- 只检索 `published`；返回片段 + 来源 + 版本 + 置信度；模型必须引用来源。
- 场景启动时可按 `knowledgeRefs` 预加载；会话中按需检索。
- 引用反馈（有效/无效/过期）进入知识质量队列，驱动复审。

**UI**

`design/knowledge.html`：四类来源卡片与统计、知识列表/筛选、知识详情（症状、根因、处置、证据、版本、来源）、待审队列、审核意见、引用统计、到期复审。

**指标**

- 自动沉淀采纳率、知识引用率、知识解决率、过期知识占比、审核时长、重复知识率。

## 10. 创造模式

### 10.1 八步流程

| 步 | 动作 | 产物 | 人工介入 |
|---|---|---|---|
| 1 目标描述 | 平台名、地址、用途、凭据 | `intent.yaml` | 用户确认 |
| 2 API 探查 | 探测 `/openapi.json`、`/swagger`、`/api`、`/v1`、`OPTIONS` | `probe-report.json` | 安全确认白名单 |
| 3 生成 Cordis bundle | dsh `cordis` 创造模式生成 SDK 代码 + tests + manifest/动作映射 | Cordis connector bundle + `tests/` | — |
| 4 沙箱验证 | disposable profile 中 `plugin_manager` 安装 + `cordis_inspect` 验证 + 离线 fixture/只读环境 | 安装/测试报告 | 允许只读联网 |
| 5 人工双审 | 安全（凭据/越权/外发）+ 领域（语义/单位/空值） | 审核意见 | **必须** |
| 6 灰度 | 单租户、写操作关闭、只读 30 天 | 调用量/错误率/延迟 | 值班观察 |
| 7 观察评审 | 错误率 < 2%、无越权、延迟达标 | 转正申请 | 审核员 |
| 8 转正入库 | 打开声明的写动作、登记目录、标 `source: ai-generated` | 正式连接器 + 变更记录 | 平台 owner |

### 10.2 硬安全约束（任一不满足即拒绝发布）

- 网络白名单：只能访问 `allowlistRef` 中的域名/IP/端口；禁 `0.0.0.0/0`；禁非标端口。
- 只读优先：首版只允许 R0/R1；写动作单独申请并逐个声明 `dryRun`。
- 凭据不落日志：请求头/体、异常栈、探针结果全量脱敏。
- 生成代码沙箱：容器内执行；除白名单无外网；根文件系统只读；seccomp；256MB 内存；60s 超时。
- 测试必过：≥ 3 条用例，覆盖正常、鉴权失败、空结果。
- **AI 生成物一律 `draft`，人工双审后才能灰度；永不自动发布。**

### 10.3 与平台的关系

创造模式是一个独立的 dsh `cordis` 会话（`studio.connector.v1`）：在一次性沙箱 profile 中生成 Cordis connector bundle（SDK 代码/测试/manifest），用 `plugin_manager` 安装、`cordis_inspect` 验证；产物进入连接器草稿库，而不是直接进运行时。运行时只加载审核通过的 bundle。

- **数据沉淀**：生成的 connector manifest 可以声明 `spec.storage.datasets`；平台校验 schema 后自动建库，**生成代码不能直接访问数据库**，只能调用平台提供的 storage API / 连接器工具。
- **数据优先策略**：审核时同时确认 `queryPolicy`、retention、数据分级；默认 `local_first`，敏感数据可要求 `live_only`。
- **消息渠道插件**：首期渠道插件只允许平台内置/人工审核（企业微信、邮件、Webhook），不由创造模式自动生成；后续开放时需额外的安全扫描。

---

## 11. 多租户与数据隔离

### 11.1 租户模型

- **租户**是计费、数据、权限、运行时的最高边界。
- 用户与租户是多对多；平台管理员分配成员关系；租户管理员维护角色。
- 每个租户有唯一 `tenant_id`（ULID），所有业务表带 `tenant_id`。
- 平台级资源（模型 Provider、平台目录、系统配置）不属于租户；租户只能引用，不能修改。

### 11.2 存储隔离矩阵

| 数据 | 存储 | 隔离方式 |
|---|---|---|
| 用户 / 租户成员 / 角色（多角色）/ 权限 | PostgreSQL | `tenant_id` + RLS；平台表单独 schema |
| 连接器 / 场景 / 分享 / 审批 / 消息 | PostgreSQL | `tenant_id` + RLS；唯一索引含 tenant |
| 插件数据集（沉淀数据） | PostgreSQL 租户 schema 或统一表 + `dataset_id` 分区 | `tenant_id + plugin_instance_id + dataset_id`；RLS；配额；按 retention 清理 |
| 知识库 / 知识版本 / 向量 | PostgreSQL + pgvector | `tenant_id` + RLS；向量检索强制租户过滤；角色/数据范围再过滤 |
| 知识文档 / 解析切片 | MinIO + PostgreSQL | 租户前缀；文档 ACL 与版本；删除/改版同步到知识状态 |
| 会话索引 | PostgreSQL | `tenant_id` + RLS；正文不存控制库 |
| 会话正文 / workspace | 租户运行时卷 | 每租户独立 `DSH_HOME`；容器挂载 |
| Commander 任务板/队友 | 会话事件 + PostgreSQL 投影 | `tenant_id + session_id`；跨用户不可见；审计 |
| 服务器 Agent 注册/指令/证据 | PostgreSQL + 主机本地 SQLite | 设备证书绑定 `host_id + tenant_id`；指令/遥测按租户校验；未知主机隔离 |
| 工具结果 / 报告 / 附件 | MinIO/S3 | `tenants/{tenant_id}/...` 前缀；租户级 SSE-KMS |
| 审计 | PostgreSQL 追加表 + 对象归档 | `tenant_id` 分区；只追加；平台可跨租户读元数据 |
| 凭据 | Vault/KMS | 租户级 DEK；信封加密；运行时短时 token |
| 消息渠道密钥（企业微信等） | Vault/KMS | 租户级；运行时/发送器短时取用；不写日志 |
| 模型密钥 | Vault/KMS | 平台级或租户级；不落运行时磁盘 |
| Redis | Redis | key 前缀 `t:{tenant_id}:`；逻辑库按环境 |
| 运行时 | 容器/进程 | 每租户独立容器 + 独立 OS 用户 + 独立网络策略 |
| 出站网络 | 代理 | 每租户 allowlist；运行时只能走代理 |
| 日志/指标 | OTel | resource 属性带 tenant；平台查询强制过滤 |

**PostgreSQL RLS 示意**

```sql
ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connectors
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

- 控制面连接池每次请求 `SET LOCAL app.tenant_id`。
- 平台管理员的跨租户查询走独立角色，只允许元数据表；业务正文表默认拒绝。
- 所有跨租户访问尝试写安全审计并告警。

### 11.3 运行时隔离

| 模式 | 适用 | 隔离强度 | 说明 |
|---|---|---|---|
| **独立运行时**（默认） | 生产/企业租户 | 强 | 每租户一个容器/命名空间 + 独立 DSH_HOME + 独立网络策略 |
| **共享池**（试用） | 试用/演示 | 中 | 同一 Pod 内每租户独立进程 + 独立 DSH_HOME + 禁用 shell/终端；仅用于低敏数据 |

- 共享池不能承载 SSH/终端类工具；生产默认独立运行时。
- 运行时启动时从控制面获取签名 capability token（tenant、user、role、allowed connectors、expiry）；所有工具调用校验。
- 会话归属：Runtime Agent 记录 `session_id → user_id`，resume/查询只能由同一用户或租户管理员（带审计）进行；跨用户 resume 直接拒绝。
- 控制面与 runtime 之间只信任 mTLS + 短时 token；不把平台数据库凭据下发给 runtime。
- 运行时没有平台数据库凭据；只通过本地 socket/HTTP 调控制面内部 API，mTLS + 短时 token。
- 会话结束后清理临时 workspace；`DSH_HOME` 保留策略按租户配置。

### 11.4 凭据安全

dsh 本地凭据默认是明文 `.credentials.yaml`（0600），不能用于多租户。平台替换为：

1. 凭据只存 Vault/KMS，控制面持有 `credentialRef`。
2. 运行时通过 `ops-credentials` 向控制面换取**短时凭据**（TTL 5–15 分钟），仅内存持有。
3. 工具执行时按 `credentialRef` 解析；日志/审计只记 ref，不记值。
4. 轮换：Zabbix Token、API Key 到期前 7 天提醒；轮换不中断运行中会话；旧值在 TTL 内可继续使用。
5. 禁止把凭据写入 prompt、会话事件、工具结果；脱敏规则兜底。
6. 消息渠道密钥（企业微信 corpId/secret/token/aesKey）走同一 Vault/KMS；发送器短时取用，不落运行时磁盘。

### 11.5 审计与合规

- 审计事件：登录、租户切换、成员变更、角色变更、连接器配置、凭据轮换、工具调用、插件数据同步/清理、知识抽取/审核/发布、消息投递/审批回执、分享申请/审批、模型配置、Commander 任务/队友变更、长任务创建/检查点/告警/暂停/恢复/取消、服务器 Agent 注册/证书/指令/证据、平台管理员跨租户操作。
- 字段：`event_id`、`tenant_id`、`actor_type/actor_id`、`action`、`resource`、`risk`、`params_hash`、`approval_id`、`result`、`ip`、`user_agent`、`created_at`。
- 只追加；180 天热存 + 对象归档；支持按租户导出 CSV/JSON。
- 平台管理员跨租户操作需二次确认 + 审计；查看会话正文默认禁止，break-glass 需双人审批并水印。

### 11.6 数据生命周期

| 数据 | 默认保留 | 删除 |
|---|---|---|
| 会话正文 | 30 天（可配 7–180） | 租户删除时级联；用户可删自己的会话 |
| 工具结果/报告 | 180 天 | 随会话/租户删除 |
| 插件数据集 | 按数据集 retention（默认 30 天 / 行数 / 配额） | 自动清理；租户删除时级联 |
| 知识库 | 发布后长期；到期复审 | 归档不物理删除；租户删除时级联 |
| 消息/投递记录 | 90 天 | 到期清理；审批关联保留 |
| 审计 | 180 天 | 到期归档；合规可延长 |
| 凭据 | 直至轮换/删除 | 删除后立即失效；审计保留 ref |
| 运行时卷 | 随租户 | 租户删除后 7 天内物理清理 |
| 备份 | 30 天 | 加密；跨区域可选 |

### 11.7 桌面端隔离

- 桌面端登录同一个平台账号，使用设备注册（mTLS 设备证书）绑定租户。
- 本地执行节点保存的是设备密钥，不是租户凭据；执行时向平台换取短时任务令牌。
- 本地命令白名单 + 逐次确认；输出脱敏后回传；本地缓存加密，退出登录清除。
- 丢失设备：平台可吊销设备证书；下次上线要求重新注册。

---

## 12. 客户端与 UI

### 12.1 Web

- 入口：`https://ops.example.com`；登录、租户选择、工作台。
- 技术：React 19 + Vite + TypeScript；路由按模块懒加载；WebSocket 用于会话/审批实时流。
- 浏览器：Chrome / Edge 最近两个大版本；1280 起；最小 1024（侧栏收起）。

### 12.2 Desktop

- Electron 壳，复用 Web 构建产物；区别：
  - 系统密钥链保存 refresh token，不写 localStorage。
  - **本地执行节点**（可选）：mTLS 连接到平台，提供内网 SSH/终端/文件能力，不把生产网络暴露给服务端。
  - 原生通知（审批、巡检完成）、开机自启、托盘、离线只读缓存。
- 首期可以先做“薄客户端”（Web 壳 + 密钥链），本地执行节点放 P2；但架构上预留。

### 12.3 信息架构

```
登录
└── 工作台（按角色视角切换）
    ├── 智能体会话（会话列表 / 详情 / 审批 / Commander 指挥）
    ├── 场景中心（列表 / 详情 / 运行报告 / 共享）
    ├── 知识中心（知识库 / 待审 / 版本 / 引用）
    ├── 消息中心（站内信 / 企业微信 / 投递 / 绑定）
    ├── 集成与插件（连接器 / 数据沉淀 / 权限 / 创造模式）
    ├── 个人偏好（外观与主题 / 时间窗口 / 会话临时切换）
    ├── 租户治理（成员与多角色 / 分享审批 / 审计）
    └── 平台管理（租户 / 模型接入 / 平台目录 / 审计 / 系统）
```

### 12.4 设计原型（19 屏）

设计稿在 `design/`，同一个目录下按顺序并排显示；建议从 `login.html` 开始，逐屏点按：

| # | 文件 | 内容 |
|---|---|---|
| 1 | `design/login.html` | LDAP 登录、租户选择、本地管理员入口 |
| 2 | `design/home.html` | 工作台：角色视角、运行健康、需要关注、进行中会话 |
| 3 | `design/chat.html` | 智能体会话：工具卡片、审批卡片、运行轨迹、产物 |
| 4 | `design/scenarios.html` | 场景中心：权限标识、场景卡片、共享状态 |
| 5 | `design/report.html` | 巡检报告：发现、证据、覆盖、健康趋势 |
| 6 | `design/connectors.html` | 集成与插件：连接器列表、数据库/中间件、健康检查、接入方式 |
| 7 | `design/connector-detail.html` | Zabbix 配置：表单、鉴权、工具、角色权限矩阵 |
| 8 | `design/studio.html` | 创造模式：对话 + Cordis bundle + 测试 + 发布 |
| 9 | `design/admin-members.html` | 成员与多角色、LDAP 同步、租户边界 |
| 10 | `design/admin-sharing.html` | 分享审批：队列、范围变化、治理检查、审批记录 |
| 11 | `design/platform-admin.html` | 平台管理：租户、模型接入（OpenAI 兼容 / Anthropic） |
| 12 | `design/desktop.html` | 桌面端：本地执行节点、内网可达、设备安全 |
| 13 | `design/appearance.html` | 外观与主题：4 种模式、时间窗口、优先级、预览 |
| 14 | `design/home-dark.html` | 深色工作台预览（用户/时间/系统解析到深色时） |
| 15 | `design/data-store.html` | 插件数据沉淀：数据集、同步、本地优先、清理 |
| 16 | `design/knowledge.html` | 知识中心：四类来源、自动沉淀、知识详情、审核、版本、引用 |
| 17 | `design/messages.html` | 消息中心：收件箱、审批、企业微信/邮件/Webhook、投递 |
| 18 | `design/incident.html` | Commander 事件指挥台：队友、任务板、证据、交接 |
| 19 | `design/tasks.html` | 长任务中心：无人值守巡检、检查点/心跳、预算、告警、人工接管 |

> 原型是可点击的 HTML（本地文件互相链接），用于确认信息架构、交互与视觉方向；不是最终前端代码。
> Commander 事件列表页（`design/incidents.html`）尚未在原型中，P1.6 前补；现有 `incident.html` 作为事件详情/指挥台。

### 12.5 设计语言

- **气质**：运维控制台 / “control room”，浅色为默认，低饱和中性色 + 信号色；避免 AI 紫渐变和玻璃拟态。
- **颜色**：浅色为默认（背景 `#F6F7F9`，表面 `#FFFFFF`，边框 `#E1E6EC`，主色 `#245BDB`，警示 `#8A5300`，成功 `#087A52`，危险 `#B42318`）；深色使用同一套语义 token 的另一组值（背景 `#0A0C0F`，表面 `#11151A`，主色 `#5B8CFF`，警示 `#FFB020`，成功 `#2FD08A`，危险 `#FF5D5D`）。
- **字体**：Inter / PingFang SC / HarmonyOS Sans / 微软雅黑；数字与命令用等宽字体；正文 13px，标签 12px，页面标题 26px，数字 34px。
- **密度**：侧栏 236px，顶栏 56px，卡片圆角 10px，间距 4/8 倍数；表格行高紧凑但可读。
- **交互**：单主操作；危险操作二次确认；审批卡固定在会话流内；工具结果可折叠；AI 回答标注“AI 生成，请结合上下文判断”。
- **无障碍**：正文对比度 ≥ 4.5:1；焦点可见；点击区 ≥ 24×24；支持 `prefers-reduced-motion`。

#### 主题与外观（本轮已确认）

主题**只有四种模式**，不额外增加自定义配色、强调色或高对比度模式：

1. **浅色**：始终浅色。
2. **深色**：始终深色（非默认）。
3. **跟随系统**（即系统自适应）：读取 `prefers-color-scheme`，系统切换时实时更新，不轮询。
4. **时间自适应**：按用户本地时间在浅色/深色之间切换。默认浅色窗口 **07:00–19:00**，其余深色；窗口可改，支持跨午夜窗口（如 22:00–06:00）；每分钟检查一次，页面重新聚焦时立即校验。

**用户默认**：用户在「外观与主题」里保存的选择写入用户偏好，跨设备生效。生效优先级：

```
当前会话临时切换 > 用户默认 > 租户默认（新成员）> 平台默认
```

- 租户管理员只能设置“新成员默认”，不覆盖已有用户的选择；平台默认作为兜底（默认浅色）。
- 外观设置页提供“当前会话临时切换”（跟随偏好 / 浅色 / 深色），只影响当前标签页，刷新或重新登录后回到用户默认。
- 自动模式只保存“模式”，不保存解析后的颜色；服务端读取用户偏好并在首屏注入 `data-theme`，避免刷新闪烁。
- 首屏策略：服务端下发 `mode` 与 `timezone`，内联 boot 脚本在样式生效前解析 system/time 并设置 `data-theme`；解析失败回退平台默认浅色。未登录页不读取个人偏好，使用平台默认浅色（带 tenant slug 时可用租户登录页默认）；登录后应用用户偏好。
- 设置页选择模式后即时预览，点击“保存偏好”才持久化；时间窗口修改同样需要保存。
- 两套主题共用同一套语义 token（背景、表面、文字、边框、状态色、代码块、图表、焦点环），只改值不改结构；两套都满足正文 4.5:1 对比度。
- 时间切换只改颜色，不刷新页面、不打断正在进行的会话；跨午夜窗口按两侧时间计算。
- 主题设置不改变权限、数据范围或审计；桌面端与 Web 读取同一用户偏好。
- 不提供自定义强调色、字体大小、高对比度等额外主题分支，避免范围膨胀；如后续需要无障碍增强，再单独立项。

原型：`design/appearance.html`（设置页）、`design/home.html`（默认浅色工作台）、`design/home-dark.html`（深色工作台）。

### 12.6 关键交互

1. **工具审批**：会话中黄色卡片，展示命令/参数、风险级别、影响范围；允许一次/查看影响/拒绝；超时默认拒绝。
2. **连接器配置**：测试连接 → 保存 → 授权角色；Token 只显示掩码；到期提醒。
3. **创造模式**：左对话、中代码/manifest、右进度与发布；测试未过不能提交审核。
4. **分享审批**：左侧队列、右侧范围变化/治理检查/审批意见；通过时只能收窄。
5. **巡检报告**：严重度分组、证据可展开、一键转工单/发起诊断会话。

---

## 13. 部署

### 13.1 拓扑

**单机私有化（首期）**

```
docker-compose
├── traefik / caddy（TLS、反代）
├── web（静态）
├── control（API）
├── worker
├── postgres
├── redis
├── minio
├── runtime-tenant-1（dsh + ops bundle）
├── egress-proxy（白名单）
└── otel-collector（可选）
```

**SaaS / 多租户（P2）**

- 控制面无状态，水平扩展；每个租户运行时由 orchestrator 调度（K8s Deployment + PVC 或 Firecracker/gVisor）。
- 独立运行时池 vs 共享池按套餐；数据库按区域；对象存储按租户前缀。
- 平台管理员与租户管理员分离域名（可选）。

### 13.2 compose 服务清单

| 服务 | 镜像 | 说明 |
|---|---|---|
| `traefik` | traefik:3 | TLS、路由、限流 |
| `web` | opsagent/web:1.0 | React 静态资源 |
| `control` | opsagent/control:1.0 | API、认证、多角色 RBAC、知识、消息、审批、主机/应用档案 |
| `worker` | opsagent/control:1.0 | 同一镜像不同命令：数据同步/清理、知识抽取、消息投递、定时场景、长任务调度 |
| `host-agent-gateway` | opsagent/host-gateway:1.0 | 主机 Agent mTLS 长连接、注册/证书、指令下发、遥测接收 |
| `postgres` | pgvector/pgvector:pg16 | 控制库、插件数据集、知识库与向量索引；备份卷 |
| `redis` | redis:7 | 队列、缓存、会话事件 fanout |
| `minio` | minio/minio | 产物、附件、数据集大字段；可选 S3 |
| `runtime` | opsagent/runtime:1.0 | dsh + ops bundle + Commander；每租户一个容器 |
| `egress-proxy` | envoy / squid | 出站白名单、审计；含企业微信私有部署出口 |
| `otel-collector` | otel/opentelemetry-collector | 可选 |

**运行时镜像构建**：

```dockerfile
FROM node:24-bookworm-slim
# 安装 dsh 固定版本（npm 或从固定 commit 构建产物）
COPY runtime/ /opt/opsagent/runtime
ENV DSH_HOME=/var/lib/opsagent/dsh
USER opsagent
ENTRYPOINT ["node", "/opt/opsagent/runtime/agent.js"]
# agent.js 负责 mTLS API + spawn `dsh --profile sdk` + stdio JSON-RPC 桥
```

> 当前 dsh 没有官方 Dockerfile；运行时镜像由平台 CI 构建，必须验证沙箱能力、Node 24、native 依赖（node-pty/ripgrep）和 `sandbox` 失败关闭行为。

### 13.3 配置与密钥

- `.env` 只放非敏感配置；敏感值进 Vault/KMS 或 Docker secret。
- 关键变量：`DATABASE_URL`、`REDIS_URL`、`S3_*`、`LDAP_*`、`KMS_*`、`RUNTIME_IMAGE`、`EGRESS_ALLOWLIST`、`HOST_AGENT_CA_*`、`HOST_AGENT_JOIN_TOKEN_TTL`。
- 首次启动：迁移数据库 → 创建平台管理员（一次性 token）→ 配置 LDAP → 创建租户。
- 平台管理员初始密码只在首次启动日志打印一次，强制修改。

### 13.4 备份、升级与可观测

| 项 | 方案 |
|---|---|
| PostgreSQL | 每日全量 + WAL 归档；跨租户恢复演练 |
| MinIO | 版本化 + 生命周期；按租户前缀 |
| 运行时卷 | 快照；租户级恢复 |
| 审计 | 只追加 + 对象归档；WORM 可选 |
| 升级 | 控制面蓝绿；运行时滚动替换；dsh 会话格式回归 |
| 指标 | API P95、工具成功率、审批时延、模型错误率、运行时 CPU/内存、队列积压 |
| 日志 | 结构化 JSON；trace_id 贯穿；脱敏 |
| 告警 | 运行时不可用、连接器鉴权失败、审计写入失败、跨租户访问阻断 |

### 13.5 容量估算（首期）

- 控制面 4C8G；PostgreSQL 4C16G/500GB（含插件数据集与 pgvector）；Redis 2C4G；MinIO 按产物量。
- 每 20 个并发会话约 8C16G 运行时；会话空闲 15 分钟回收；Commander 事件按 4–8 个队友预留并发与 Token 预算。
- 长任务按每租户 3–5 个并发预留；无人值守巡检默认 30 分钟一次，平台健康巡检与租户巡检错峰。
- 插件数据集默认每连接器 5GB 配额；知识库按 10 万条/租户估算，向量索引随 pgvector 增长。
- 单租户 50 用户、10 个连接器、20 个场景的基线。

---

## 14. 首期范围与里程碑

### 14.1 P0 技术验证（2–3 周）

目标：证明 6 件事，降低架构风险。

1. `dsh --profile sdk` 跑在容器里；平台用 SDK JSON-RPC 创建/恢复 2 个会话，接收事件与审批。
2. 自定义 `tool-zabbix`（只读）在运行时注册，能查询真实 Zabbix；审批桥可拒绝/允许。
3. `llm-pi-ai` 同时接通 OpenAI 兼容网关与 Anthropic；流式与工具调用正常。
4. 每租户独立 `DSH_HOME` + 卷 + capability token；跨租户 sessionId 被拒。
5. 插件数据沉淀：自动建数据集、增量同步、local_first 回源、TTL 清理 dry-run。
6. 企业微信（私有部署）发送审批卡片并接回调；知识抽取生成 draft 并进入审核队列。

**验收**：演示脚本 + 审计日志 + 隔离测试报告 + 数据/知识/消息闭环截屏；形成《运行时集成说明》。

### 14.2 P1 MVP（12 周，含完整创造模式）

| 模块 | 范围 |
|---|---|
| 身份 | LDAP 登录、本地管理员、平台管理员/租户管理员/成员/审计员、租户成员分配 |
| 角色 | 多职能角色、角色-权限并集、工作台视角切换；知识管理员角色内置 |
| RBAC | 连接器 × 能力 × 角色授权、工具双重校验 |
| 连接器 | Zabbix、Prometheus、Grafana、Alertmanager、ClickHouse、MySQL、PostgreSQL、Redis、SSH 只读；表单配置、健康检查、权限矩阵 |
| 会话 | Web 会话、流式、工具卡片、审批卡片、运行轨迹、产物 |
| 场景 | 巡检、指标异常分析、告警根因/故障诊断；定时 + 手动；报告 |
| 创造模式 | 描述 → API 探查 → 生成 manifest/测试 → 沙箱测试 → 租户管理员审核 → 灰度 → 观察 → 转正/回滚（完整 8 步） |
| 分享 | 个人 → 角色 → 租户共享（租户管理员审批）；平台共享入口（租户管理员审核） |
| 模型 | 平台 Provider（OpenAI 兼容 + Anthropic）、租户白名单、配额、用量 |
| 治理 | 审计、连接器配置审计、审批记录、租户隔离测试 |
| 部署 | docker-compose、TLS、备份、初始化脚本 |
| 客户端 | Web；Desktop 薄壳（P1.5） |

**P1 不做**：平台市场跨租户安装、R3 写操作、自动修复、移动端、K8s/Kafka 连接器、多区域。

### 14.3 P1.5（+8 周）：数据、知识、消息、长任务与 Desktop

| 模块 | 范围 |
|---|---|
| 插件数据沉淀 | storage schema、自动建库、同步/回源、本地优先、TTL 清理；先覆盖 Zabbix/Prometheus/ClickHouse/MySQL |
| 知识管理 | 四类来源（插件数据每日增量+每周深度、PDF/Word/Excel/MD/HTML/CSV 文档、租户统一开启的对话、平台运行）、自动抽取草稿、知识库、知识管理员审核、版本、租户内共享、Agent 引用 |
| 消息中心 | 站内信、企业微信（私有部署）、邮件、Webhook 渠道插件、审批卡片、投递/重试/绑定 |
| 连接器扩展 | Kubernetes、Kafka、Elasticsearch/OpenSearch、MongoDB、Nginx、RabbitMQ |
| 长任务 | 持久化任务、检查点/心跳/恢复、无人值守巡检、平台健康巡检、异常自动告警；预算与人工接管 |
| 客户端 | Desktop 薄壳 |

### 14.4 P1.6 Commander（+8 周 + 2 周 contingency，connector-only）

| 模块 | 范围 |
|---|---|
| 融合 | 选择性 fork/裁剪 dsh-superagent：保留 core/Effects/Outbox/Policy；每租户一个 commander 实例 |
| 事件域 | Incident/Ticket/Assignment/Evidence/Hypothesis/Approval；事件列表/详情 |
| Source | Alertmanager/Zabbix/Agent 异常/人工事件；去重/分组/严重度 |
| Executor | ConnectorExecutor（Prometheus/Zabbix/ClickHouse/DB）；SpecialistExecutor（DSH 只读专家）；HostAgentExecutor 留 P2-B |
| Commander | 定级/拆任务/并行派发/证据/根因/审批/报告；无 shell |
| UI | OpsAgent Web 原生事件指挥台 |

### 14.5 P2（+20 周：P2-A 12 + P2-B 8）

- 创造模式进阶：更多协议适配、测试生成增强、模板市场。
- 平台共享市场 + 跨租户安装 + 平台目录治理。
- Desktop 本地执行节点（mTLS、设备管理、内网 SSH/终端）。
- Commander：接入 dsh Agent Teams（durable roster/task board/wait-steer），扩展更多专业队友与跨班次交接（P2 评估）。
- Server Agent：P2-A 12 周（Linux、Eino ADK 轻量 Agent Runtime、注册/发现/采集/巡航/CLI、纳管）+ P2-B 8 周（签名诊断、受控部署/升级、证据、排障闭环）；P3 扩展虚拟化/存储/网络 Agent 与高级部署。
- 消息：值班表、升级策略、更多消息模板。
- 知识：角色/团队范围、知识包导出、embedding 模型可选、复审自动化。
- 连接器：云监控、网络设备（SNMP）、AWX/Ansible、CMDB/ITSM、VictoriaMetrics、Loki。
- 场景：容量、变更、日志、资产、日报。
- K8s 部署、配额计费、多区域。

### 14.6 团队与分工

| 角色 | 人数 | 职责 |
|---|---|---|
| 后端 / 平台 | 2 | 控制面、RBAC、审批、审计、运行时编排 |
| 智能体 / 连接器 | 2 | ops bundle、工具、模型网关、场景 DSL |
| 前端 | 1–2 | Web 控制台、设计系统 |
| 测试 / 安全 | 1 | 租户隔离、越权、审批、渗透 |
| 产品 / 设计 | 0.5 | 场景梳理、原型、验收 |

---

## 15. 已确认决策与实现默认值

| # | 决策 | 确认结果 | 备注 |
|---|---|---|---|
| 1 | 复用路线 | **C**：dsh 独立运行时 + SDK + 薄 bundle | 不 fork agent-loop |
| 2 | 平台共享审批 | **租户管理员审核**后进入平台目录 | 平台管理员只做目录治理/下架 |
| 3 | 隔离档位 | 生产独立运行时，试用共享池 | 共享池禁用 shell/终端 |
| 4 | 桌面端 | 薄客户端（Web 壳 + 密钥链）；本地执行节点 P2 | |
| 5 | 首期连接器 | Zabbix / Prometheus / Grafana / Alertmanager / ClickHouse / MySQL / PostgreSQL / Redis / SSH | P1.5 加 K8s/Kafka/ES/MongoDB/Nginx/RabbitMQ |
| 6 | 模型密钥 | 平台统一 Key 默认 + 租户 BYOK 可选 | |
| 7 | 身份源 | **LDAP + 本地管理员**；不接入 OIDC | 本地管理员仅初始化/断网 |
| 8 | 技术栈 | TypeScript 全栈（Fastify + React + PostgreSQL/pgvector + Redis + MinIO）+ Electron | 与 dsh 同栈 |
| 9 | 部署形态 | 私有化 docker-compose 优先，K8s 后续 | |
| 10 | 创造模式 | **P1 完整 8 步流水线**（含灰度/观察/转正/回滚） | 进阶协议/模板 P2 |
| 11 | UI 主题 | 浅色 / 深色 / 跟随系统 / 时间自适应；默认浅色 | 用户可设默认 |
| 12 | 审计保留 | 180 天热存 + 归档 | |
| 13 | 角色模型 | 管理身份 + 多职能角色；权限并集、视角切换；知识管理员是角色 | |
| 14 | 插件数据默认策略 | 读本地优先、写实时；默认保留 30 天、单连接器 5GB | 可按数据集配置 |
| 15 | 知识审核 | 自动抽取只生成草稿；知识管理员审核后发布；仅租户内共享 | AI 永不自动发布 |
| 16 | Commander | P1.6 选择性 fork/裁剪 dsh-superagent；每租户一个实例；无 shell；P2-B 接 Host Agent | 含 Incident/Evidence/Approval；UI 原生 |
| 17 | 消息渠道 | 企业微信（私有部署，默认）+ 邮件 + Webhook；站内信兜底 | 钉钉/飞书暂不接入 |
| 18 | 知识来源边界 | 对话租户统一开启 + 脱敏 + 审核；文档继承 ACL；插件数据只读；格式 PDF/Word/Excel/MD/HTML/CSV；知识范围不宽于来源 | |
| 19 | 长任务 | 持久化任务 + 检查点/心跳/恢复；无人值守巡检与平台健康巡检；异常自动告警 | 预算/并发/人工接管 |
| 20 | Commander 融合 | fork/裁剪 + 每租户实例 + 无 shell 类型化工具 + OpsAgent Web 原生 UI | P1.6 8 周；P2-B 接 Host Agent |

以上均已确认；剩余为实现默认值，不需要再逐项拍板。

### 15.1 Server Agent（已确认）

| # | 确认 | 落地 |
|---|---|---|
| S1 | 首发 OS | Linux（systemd）优先；Windows/macOS 后续 |
| S2 | 运行权限 | **默认 root + 动作级权限门控**；CLI 普通用户；无裸 Shell |
| S3 | 自动纳管 | 一次性令牌 + CSR；网段/标签自动批准，其他人工；未知主机隔离 |
| S4 | LLM | 模型对接信息服务端下发；Agent 不持有厂商 Key |
| S5 | 快照 | **最长 1 天**：5s 1h / 30s 6h / 5m 24h；异常 24h/200MB；总上限 1GB 或 2% |
| S6 | 写能力 | P2-B 支持受控部署/升级（变更单 + 签名制品 + canary + 回滚）；不做任意 Shell |

---

## 附录 A：术语

| 术语 | 含义 |
|---|---|
| 租户（Tenant） | 数据、权限、计费、运行时的最高边界 |
| 角色（Role） | 租户内的职能身份；用户可绑定多个，权限取并集，决定工作台视角 |
| 插件数据沉淀 | 插件把对端数据同步到平台数据集，读本地优先、回源兜底 |
| 知识管理员 | 负责知识审核/发布/归档的职能角色，可由普通成员担任 |
| Commander | 指挥智能体 + 专业队友 + 任务板/证据板的事件编排模式 |
| 渠道插件 | 消息中心对接企业微信/邮件/Webhook 的插件 |
| 连接器（Connector） | 对接一个外部运维平台的配置与能力集合 |
| 能力（Capability） | 连接器暴露的一个动作，如 `problem.list` |
| 工具（Tool） | 能力在模型侧的呈现，如 `zabbix_problem_list` |
| 场景（Scenario） | 参数化的运维流程，编排工具/子智能体/产物 |
| 插件（Plugin） | 连接器、场景、skill 等可发布物的统称 |
| R0–R3 | 只读 / 低危写 / 高危写 / 禁止 |
| 创造模式 | AI 生成非标平台连接器的过程 |
| DSH_HOME | dsh 运行时数据目录（会话、workspace、凭据） |

## 附录 B：关联文档

- `docs/design/research/harness-capability-map.md`：dsh 运行时、扩展点、模型、持久化、认证、部署、A/B/C 对比与集成建议。
- `docs/design/research/ops-connectors-and-scenarios.md`：20 个连接器、manifest schema、工具契约、9 个场景、分享状态机、创造模式安全约束。
- 设计原型：`design/`（19 屏）；截图在 `design/_shots/`。

## 附录 C：本设计明确不做的事

- 不把 dsh 的 agent-loop 当作定制点；不在平台代码里依赖 dsh 内部 `src`。
- 不允许平台管理员默认查看租户会话正文。
- 不允许场景分享放大权限；不允许 AI 生成物自动发布。
- 不允许租户自定义 MCP stdio 命令（只允许平台白名单）。
- 不允许把凭据写进 prompt、会话事件、工具结果或日志。
