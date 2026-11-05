# OpsAgent 开发落地路径（v1.1，执行基线已确认）

> **执行状态 2026-11-05（0.3.2 交付）**：本文是 48 周目标计划，当前代码已完成 P1/P1.5/P1.6/P2-A/P2-B 的主要能力并进入验收阶段。
> 已落地：租户/RBAC/审计/Web、9 个连接器、场景/调度/报告/分享、Studio、知识/消息/数据/长任务、Commander 事件域、Host Agent 安装/发现/巡航/只读 exec、服务生命周期审批、签名命令与结果、签名 Release/预检/部署/主机 canary/流量级 canary/回滚、Desktop 薄客户端、内网 CA/CSR/mTLS/CRL/OCSP、systemd/容器/Windows Job Object 限额。
> 验收：221 单测/API 通过、14 E2E 通过、Go 测试通过、构建通过，详见 `docs/design/plans/2026-11-04-acceptance-status.md`。
> 外部待签：G0 正式兼容矩阵、十台混合环境、Windows 实机压测、正式代码签名证书、生产入口代理/OCSP 域名、安全/运维/产品签字，详见 `docs/FINAL-DELIVERY.md`。
> Sprint 1 的逐项校准见 `docs/design/plans/2026-11-03-p1-sprint-1.md`；最终交付见 `docs/FINAL-DELIVERY.md`。
> 设计基线：`docs/design/00-platform-design.md`（19 屏原型在 `design/`）。

## 0. 结论先行

- **周期**：P1 **12 周** + P1.5 **8 周** + **P1.6 Commander 8 周** + P2-A **12 周** + P2-B **8 周**，共 **48 周**；P2 的其他增强另排。
- **原则**：不裁功能。范围增加就顺延，不用“先不做”换时间。
- **范围**：P1 完成平台底座、9 个连接器、3 个场景、**完整继承 dsh `cordis` 创造模式的连接器插件生成**、审批/审计/分享、Web；P1.5 完成插件数据沉淀、知识管理、消息中心、长任务/无人值守巡检、Desktop 薄客户端；P1.6 完成 **dsh-superagent 派生的 Commander（connector-only 事件指挥）**；P2-A/B 接客户端 Agent 与完整根因闭环。
- **人力假设**：6.5 FTE（见第 8 节）；人力不足则整体顺延，不裁功能。
- **执行基线已确认**：12 + 8 + 8 + 12 + 8 周、6.5 FTE、G0–G10、创造模式完整继承 dsh；剩余只做任务级拆分。

## 1. 范围基线

### P1（12 周）

| 域 | 必须交付 |
|---|---|
| 平台底座 | 多租户、LDAP + 本地管理员（无 OIDC）、9 个内置角色、多角色并集、RBAC、审批、**180 天审计**、租户隔离、模型 Provider（OpenAI 兼容 + Anthropic，平台 Key + 租户 BYOK）、docker-compose |
| 运行时 | dsh 固定版本、Runtime Agent、SDK 会话/恢复、工具注册、审批桥、事件/产物、租户 capability token |
| 连接器 | Zabbix、Prometheus、Grafana、Alertmanager、ClickHouse、MySQL、PostgreSQL、Redis、SSH；通用 HTTP；MCP 白名单 |
| 场景 | 巡检、指标异常分析、告警根因/故障诊断；手动 + 定时；报告；分享 |
| 创造模式 | **完整继承 dsh `cordis` 创造模式**：目标 → 探查 → 用 dsh 创造模式生成 Cordis connector plugin bundle（含 SDK 代码/测试/manifest）→ 沙箱 profile 安装 → 审核 → 灰度 → 观察 → 转正/回滚 |
| Web | 登录、工作台、会话、场景、报告、连接器、创造模式、成员/角色、分享、平台管理、外观主题；**四模式（浅/深/系统/时间），默认浅色，07:00–19:00 浅色窗口** |
| 质量 | 租户隔离、越权、审批、连接器契约、dsh 兼容、备份恢复、性能基线 |

### P1.5（8 周）

| 域 | 必须交付 |
|---|---|
| 插件数据沉淀 | 数据集声明、自动建库、同步/回源、本地优先、**30 天/单连接器 5GB 默认**、四种查询策略、TTL/行数/配额清理、存储 UI |
| 知识管理 | 四类来源、知识智能体、文档上传（PDF/Word/Excel/MD/HTML/CSV，**继承文档 ACL**）、租户对话开关、**历史显式回溯 90 天**、审核/版本/引用、**永不自动发布**、**来源采信顺序**、知识管理员可由普通成员担任 |
| 消息中心 | 站内信、企业微信（私有部署）、邮件、Webhook；审批卡片、路由、模板、静默/升级、重试、回执 |
| 长任务 | 持久化任务、检查点/心跳/恢复、无人值守巡检、平台健康巡检、异常自动告警、人工接管 |
| 连接器扩展 | Kubernetes、Kafka、Elasticsearch/OpenSearch、MongoDB、Nginx、RabbitMQ |
| Desktop | 薄客户端（Web 壳 + 系统密钥链），本地执行节点仍 P2 |

### P1.6 Commander（8 周 + 2 周 contingency，connector-only）

| 域 | 必须交付 |
|---|---|
| 融合底座 | fork/裁剪 dsh-superagent：保留 core/Effects/Outbox/Policy 骨架；每租户一个 commander 实例；不直接接 bundle |
| 事件域 | Incident / Ticket / Assignment / Evidence / Hypothesis / Approval；事件列表与详情 |
| Source | Alertmanager/Zabbix/Agent 异常/人工事件；去重、分组、严重度、Thread 聚合 |
| Executor | ConnectorExecutor（Prometheus/Zabbix/ClickHouse/DB 插件）；SpecialistExecutor（复用 DSH 只读专家会话）；HostAgentExecutor 留到 P2-B |
| Commander | 总调度智能体：定级、拆任务、并行派发、证据汇总、假设/根因、审批、报告 |
| 安全 | 无 shell；类型化工具；R0–R3；插件只读；审计；人工 break-glass 不进模型 |
| UI | OpsAgent Web 原生事件指挥台；不嵌入 dsh-superagent panel |

### P2（28 周之后）

P2-A 客户端 LLM Agent（12 周）；P2-B HostAgentExecutor、部署/升级与完整根因闭环（8 周）；Agent Teams 稳定接入、Desktop 本地执行节点、平台市场跨租户安装、创造模式进阶（更多协议/模板市场/测试生成增强）、K8s 部署、计费、多区域、更多连接器。

### 1.1 创造模式：完整继承 dsh，不另造生成器

已确认：**创造模式不重写，直接使用 deepseek-harness 的创造模式（`cordis` preset）**，由它自动生成可安装的对接插件。

dsh 已有的能力：

- `cordis` agent preset：创造模式会话，带代码/文件工具、`plugin_manager`、只读 `cordis_inspect_*` 运行时检查。
- `plugin_manager install_bundle`：把组合包安装到当前 profile；支持 HMR、`applied` / `restart-required` / 失败诊断。
- 创造模式 skills：`agent-experience`、`cordis-plugin-development`、`editing-cordis-compositions`、`cordis-composition-reference`（含 references/templates）。
- Cordis 组合包格式：`cordis.yml` patch + 插件包；这是“生成对接插件”的载体。

OpsAgent 只做四层封装，不复制它的生成逻辑：

1. **OpsAgent Connector SDK**：`@opsagent/connector-sdk`，提供 `defineConnector` / `defineTool` / auth / HTTP / 分页 / 脱敏 / schema / 测试 helper，让 dsh 生成的插件符合平台工具契约。
2. **OpsAgent Connector Skill + 模板**：`opsagent-connector-authoring` skill + `templates/connector-bundle`，告诉 dsh 创造模式如何生成 OpsAgent 连接器插件、manifest、测试和文档。
3. **Studio 编排**：Studio 页面启动一个租户隔离的 dsh 会话，`agentPreset: cordis`，挂载上述 skill/template，工作区在一次性沙箱目录；不接触生产 profile。
4. **沙箱/审核/灰度**：生成的 bundle 先安装到 disposable `opsagent-studio` profile，用 `cordis_inspect_*` 验证工具注册，跑契约测试；通过后由租户管理员审核，再安装到租户 profile 做灰度/观察/转正/回滚。

8 步流程与 dsh 的对应：

| 步骤 | dsh 创造模式做什么 | OpsAgent 平台做什么 |
|---|---|---|
| 1 目标 | 读取目标平台描述、API 文档、样例 | 表单/文档/凭据引用；租户隔离 |
| 2 探查 | 用代码/HTTP 工具探查 OpenAPI/端点 | 出站 allowlist、只读凭据、超时/预算 |
| 3 生成 | 写 Cordis connector bundle + SDK 代码 + tests + manifest | 模板/skill 约束；产物落沙箱工作区 |
| 4 沙箱 | `plugin_manager install_bundle` 到沙箱 profile；`cordis_inspect_*` 验证 | 一次性 profile、无生产数据、HMR 验证 |
| 5 审核 | 生成 diff/测试报告/风险清单 | 租户管理员审核；安全扫描；不可自动发布 |
| 6 灰度 | 安装到租户 profile 的灰度入口 | 单租户/只读/观察期；版本固定 |
| 7 观察 | 工具调用、错误率、延迟、审计 | 观察指标；失败自动暂停 |
| 8 转正/回滚 | 保留/卸载 bundle；恢复上一版 | 版本 diff、转正、回滚、审计 |

协议边界：Connector SDK 在 P1 提供 REST/OpenAPI、JSON-RPC、SOAP/WSDL、gRPC（reflection/proto）适配；任意私有加密协议/私有 SDK 不走自动生成，走人工插件。协议适配属于 SDK 能力，不改 dsh 创造模式本身。

## 2. 交付原则

1. **纵向切片**：每个里程碑都交付“可登录、可操作、可审计”的端到端路径，不先铺完所有表再做页面。
2. **dsh 只做运行时**：固定版本、只用公开 SDK/bundle/defineTool；不 import 内部 `src`，不 fork agent-loop。创造模式直接使用 dsh `cordis` preset，不复制其生成逻辑。
3. **租户隔离先于功能**：所有表、对象、向量、运行时、消息、任务都带 `tenant_id`；每个阶段跑跨租户拒绝测试。
4. **危险动作先审批**：任何 R2+ 写操作在 P1 就接审批；长任务默认只读，不自动修复。
5. **不做“假成功”**：运行时不可用、消息未送达、数据回源失败、任务心跳丢失，都必须显式失败或 paused。
6. **可回滚**：dsh 升级、创造模式发布、连接器版本、知识版本、长任务都有回滚/撤销路径。
7. **不裁功能**：范围变化走变更单；时间不够就延长里程碑。

## 3. 里程碑时间线

| 周 | 阶段 | 关键结果 | Gate |
|---|---|---|---|
| W1–2 | P0 技术验证 | dsh、SDK、工具、审批、模型、隔离、创造模式沙箱、长任务恢复 | **G0** |
| W3–4 | P1 Sprint 1 | 租户/身份/RBAC、运行时、会话骨架、审计、Web Shell、主题 | G1 |
| W5–6 | P1 Sprint 2 | 连接器框架 + Zabbix/Prometheus/Grafana/Alertmanager；会话/审批/产物 | G2a |
| W7–8 | P1 Sprint 3 | ClickHouse/MySQL/PostgreSQL/Redis/SSH；场景中心 + 巡检/指标分析 | G2b |
| W9–10 | P1 Sprint 4 | 故障诊断、报告、分享、创造模式主流水线 | G3a |
| W11–12 | P1 Sprint 5 | 创造模式灰度/观察/转正/回滚；平台共享；硬化/发布 | **G4 / P1** |
| W13–14 | P1.5 Sprint 1 | 数据沉淀、消息中心、知识文档接入、长任务骨架 | G5 |
| W15–16 | P1.5 Sprint 2 | 知识智能体四来源、无人值守巡检、企业微信/邮件/Webhook、Desktop | G6a |
| W17–18 | P1.5 Sprint 3 | 长任务 UI、知识审核/引用、全部页面；**不含 Super Agent** | G6b |
| W19–20 | P1.5 Sprint 4 | 隔离/性能/安全/兼容性/备份恢复；发布 | **G7 / P1.5** |
| W21–22 | P1.6 Sprint 1 | fork/裁剪 dsh-superagent；Incident/Evidence/Approval 骨架；每租户 commander | G8a |
| W23–24 | P1.6 Sprint 2 | Alert/Agent Source；ConnectorExecutor；Commander 工具；去重/分组 | G8b |
| W25–26 | P1.6 Sprint 3 | 事件指挥 UI；并行取证；假设/根因；审批；WeCom 时间线 | G8c |
| W27–28 | P1.6 Sprint 4 | 无 shell 安全验收、故障演练、性能/审计、发布 | **G8 / P1.6** |
| W29–40 | P2-A | Linux Host Agent、Eino ADK 轻量 Agent Runtime、注册/发现/采集/CLI、Gateway/Registry | **G9** |
| W41–48 | P2-B | HostAgentExecutor、签名诊断、受控部署/升级、证据回传、根因闭环、灰度 | **G10 / P2-B** |

> 里程碑是**功能门禁**，不是演示门禁：每个 Gate 必须同时通过功能、隔离、审计、失败路径检查。

## 4. 工作流与依赖

| 工作流 | 负责 | 主要产出 | 依赖 |
|---|---|---|---|
| WS1 运行时与 dsh 兼容 | Runtime 工程师 | 运行时镜像、Runtime Agent、SDK 契约、长任务恢复 | P0 |
| WS2 控制面与身份 | 后端 A | 租户、LDAP、角色、RBAC、审批、审计、模型/配额 | P0 |
| WS3 连接器平台 | 集成工程师 | manifest、工具契约、9 个连接器、健康/凭据/出站 | WS1/WS2 |
| WS4 场景与创造模式 | 全栈 B | 场景 DSL、3 个场景、报告、dsh `cordis` 创造模式编排、Connector SDK/模板/skill、沙箱/灰度 | WS1/WS3 |
| WS5 Web/Desktop | 前端 | 19 屏 + 事件列表/指挥台、主题、交互、桌面薄壳 | WS2 起 |
| WS6 数据/知识/消息/长任务 | 后端 B + 全栈 B | P1.5 全部能力 | P1 + WS3 |
| WS7 质量与安全 | QA/安全 | 隔离、越权、契约、性能、恢复、发布 | 全阶段 |
| WS8 Commander | 后端 B + 全栈 B + Runtime | fork/裁剪 dsh-superagent、Incident/Evidence/Approval、Source/Executor、Commander/UI | P1.5 + WS3 |

**关键路径**：

```
P0 dsh/SDK → 控制面身份/运行时 → 连接器框架 → 会话/审批
  → 场景/报告 → 创造模式 → P1 发布
  → 数据沉淀 → 知识/长任务 → P1.5 发布
  → Commander（fork dsh-superagent）→ P1.6
  → Host Agent（P2-A）→ HostAgentExecutor/根因（P2-B）
```

**可并行**：9 个连接器按监控/数据库/主机分组并行；Web 页面按 IA 并行；消息中心与审批事件可提前；知识文档接入与长任务骨架可提前；Commander 的 fork/Incident 骨架可在 P1.5 后期预研。

## 5. 分阶段落地

### P0：技术验证（W1–2）

目标：把“可能推翻架构”的 7 件事先验证；不追求完整 UI。

**验证项**

1. `dsh --profile opsagent-runtime` 容器化启动；SDK JSON-RPC 创建/恢复 2 个会话。
2. 自定义 `tool-zabbix` 注册、只读查询、审批 allow/deny、事件回流。
3. `llm-pi-ai` 同时接通 OpenAI 兼容与 Anthropic；流式、工具调用、错误码。
4. 每租户独立 `DSH_HOME` + capability token；跨租户 sessionId 拒绝；会话正文平台管理员不可读。
5. 9 个连接器的认证/查询最小探针（至少 Zabbix、ClickHouse、MySQL、SSH 真机/容器）。
6. 创造模式：验证 dsh `cordis` preset、创造模式 skills、`plugin_manager`、`cordis_inspect_*`；在 disposable `opsagent-studio` profile 生成并安装一个最小 connector bundle，确认工具注册、测试、隔离、不可发布。
7. 长任务：dsh `jobs`/`schedule` + 平台任务实体，检查点/心跳/恢复原型；企业微信回调验签探针。

**退出条件 G0**

- 7 项全部有结论；阻断项有明确解决方案或范围调整建议。
- 输出《运行时集成说明》《兼容性矩阵》《P0 风险清单》。
- 不通过则不开 P1；先修架构问题。

### P1 Sprint 1（W3–4）：平台底座

- 控制面：租户、用户、成员、**9 个内置角色**（含知识管理员）、权限并集、RLS、**180 天审计**。
- LDAP 登录 + 本地管理员（无 OIDC）；平台管理员分配租户/初始角色；租户管理员维护成员与权限；**只有租户管理员能配置插件和授权角色**。
- Runtime Agent、会话 create/resume、事件流、审批桥、产物存储、模型 Provider（**OpenAI 兼容 + Anthropic；平台 Key + 租户 BYOK**）。
- Web Shell：登录、工作台、消息/设置入口、**主题四模式、默认浅色、07:00–19:00 浅色窗口、无 FOUC**。
- 安全验收：平台管理员默认不能读租户会话正文；跨租户 session 拒绝。
- **G1**：一个租户完成登录 → 角色视角 → 新建会话 → 调用 mock 工具 → 审批 → 审计；跨租户拒绝。

> Sprint 1 任务级计划（文件/接口/测试/提交粒度）：`docs/design/plans/2026-11-03-p1-sprint-1.md`。G1 通过后再拆 Sprint 2–5。

### P1 Sprint 2（W5–6）：连接器框架 + 监控连接器

- Connector manifest、工具契约、凭据引用、健康检查、出站 allowlist、tenant/role 双重校验、**按角色授权（仅租户管理员可配）**。
- **MCP 白名单**：平台管理员登记 server、发现工具、只读准入；不允许租户自定义 stdio 命令。
- Zabbix、Prometheus、Grafana、Alertmanager：只读能力、测试用例、权限矩阵、UI 配置。
- **Connector SDK + `opsagent-connector-authoring` skill 骨架**：`defineConnector/defineTool`、模板、契约测试 harness，供创造模式生成插件。
- 会话 UI：流式、工具卡片、审批卡片、运行轨迹、产物、失败/重试。
- **G2a**：4 个连接器契约测试通过；Connector SDK/模板骨架可被 dsh 创造模式调用；审批拒绝生效；凭据不落盘/不进 prompt。

### P1 Sprint 3（W7–8）：数据库/主机连接器 + 场景

- ClickHouse、MySQL、PostgreSQL、Redis：只读账号、参数化模板、查询上限、健康检查。
- SSH：命令白名单、跳板机、只读、交互二次确认。
- 场景 DSL：巡检、指标异常分析；手动/定时；产物模板；报告页。
- **G2b**：9 个连接器全部通过契约 + 隔离测试；2 个场景端到端出报告。

### P1 Sprint 4（W9–10）：故障诊断 + 创造模式主流水线

- 告警根因/故障诊断场景（事件指挥完整编排放 P1.6，P1 只做诊断会话与报告）。
- 分享：个人 → 角色 → 租户共享 → 平台共享（租户管理员审核）。
- 创造模式：OpsAgent Connector SDK/模板/skill 完备；Studio 启动租户隔离的 dsh `cordis` 会话，生成 Cordis connector bundle；安装到 disposable `opsagent-studio` profile，用 `cordis_inspect_*` 验证工具注册并跑契约测试；租户管理员审核。
- **G3a**：一个真实非标 HTTP 平台由 dsh 创造模式生成 Cordis connector bundle，在沙箱 profile 安装、inspect、测试通过；测试未过不能发布。

### P1 Sprint 5（W11–12）：创造模式完整闭环 + 发布

- 灰度：把审核通过的 bundle 安装到租户 profile 的灰度入口；单租户/只读/观察期、观察指标、转正、回滚；版本 diff。
- 验证 dsh 创造模式产物的可安装性、工具 schema、`cordis_inspect_*` 结果、HMR/restart-required 行为。
- 平台共享目录（租户管理员审核；平台管理员只治理/下架）。
- 硬化：租户隔离、越权、审批、性能、备份恢复、dsh 兼容回归、**docker-compose 一键部署与升级/回滚**。
- **G4 / P1 发布**：P1 范围页面（登录/工作台/会话/场景/报告/连接器/创造模式/成员/分享/平台管理/外观）可用；所有 P1 功能验收；无 blocker。

### P1.5 Sprint 1（W13–14）：数据沉淀 + 消息 + 文档 + 长任务骨架

- 插件数据：manifest `storage.datasets`、自动建库、同步/回源、本地优先、**默认 30 天 / 单连接器 5GB**、**四种查询策略（本地优先/实时优先/仅本地/仅实时）**、清理任务、配额。
- 消息中心：站内信、企业微信（私有部署）、邮件/Webhook 适配、审批卡片、**路由/模板/静默/升级**、重试/回执。
- 知识文档：上传、病毒扫描、解析、切片、embedding、**ACL 继承/版本/删除同步**；支持 PDF/Word/Excel/MD/HTML/CSV。
- 长任务：任务实体、调度、检查点、心跳、预算、暂停/恢复。
- **G5**：数据本地优先/过期回源/清理 dry-run；企业微信审批卡片回调；文档入库；长任务恢复。

### P1.5 Sprint 2（W15–16）：知识智能体 + 无人值守巡检 + Desktop

- 知识智能体：四类来源适配器、抽取 JSON、去重/质检、草稿队列；文档来源完整可用。
- 对话来源：租户开关、脱敏、历史显式回溯（默认 90 天）、审核；知识正文不保存原对话。
- 平台运行来源：巡检/场景/事件产物。
- 知识门禁：**永不自动发布**、知识管理员审核/版本/引用、**采信顺序（文档≈平台运行 > 插件数据 > 对话）**、知识管理员可由普通成员担任。
- 长任务：平台健康巡检 + 租户系统巡检；异常告警；告警去重；人工接管。
- 连接器扩展：Kubernetes、Kafka、Elasticsearch/OpenSearch、MongoDB、Nginx、RabbitMQ。
- Desktop 薄客户端：登录、会话、审批、通知、密钥链。
- **G6a**：四类来源均能产出草稿；无人值守巡检自动告警；Desktop 可登录/审批。

### P1.5 Sprint 3（W17–18）：知识闭环 + 页面

- 知识审核/版本/引用/反馈/复审；知识中心四来源 UI；`knowledge.search` 引用。
- 长任务中心、消息中心、数据沉淀、知识中心全部页面接真实数据。
- **G6b**：一次无人值守巡检 + 一条知识从草稿到发布/引用全链路。

### P1.5 Sprint 4（W19–20）：硬化与发布

- 租户隔离/越权/审批/消息/知识/长任务端到端；跨租户拒绝；知识来源 ACL 不放大。
- 性能：登录、会话首 token、连接器查询、知识检索、消息投递。
- 故障注入：runtime 崩溃、DB 连接丢失、企业微信超时、长任务心跳丢失、dsh 升级回滚。
- 备份恢复、升级/回滚手册、运维手册；**19 屏全部页面可用（含深色/浅色）**。
- **G7 / P1.5 发布**：全部确认功能可用；无 blocker；已知限制清单签字。

### P1.6 Commander（W21–28，connector-only）

**Sprint 1（W21–22）：fork 与事件域骨架**

- fork/裁剪 dsh-superagent：保留 core/Effects/Outbox/Policy，删除 GitHub/Feishu/编码专用代码。
- 每租户一个 commander 实例；SQLite/stateDir/凭据隔离。
- Incident/Ticket/Assignment/Evidence/Hypothesis/Approval 聚合；无 shell 的 Commander/Worker 工具面。
- **G8a**：模拟告警 → Incident → 任务 → 证据写入；跨租户拒绝；无 shell。

**Sprint 2（W23–24）：Source + ConnectorExecutor**

- AlertSource（Alertmanager/Zabbix）+ Agent 异常源 + 人工事件；去重/分组/严重度/Thread 聚合。
- ConnectorExecutor：Prometheus/Zabbix/ClickHouse/DB 插件并行查询，结果证据化。
- Commander 工具：`incident.open/assign`、`connector.query`、`evidence.add/query`、`hypothesis.update`。
- **G8b**：一次真实告警 → 多插件证据 → 假设列表；查询超时/失败可审计。

**Sprint 3（W25–26）：事件指挥 UI + 根因/审批**

- OpsAgent Web 原生事件指挥台：列表、时间线、任务板、证据板、假设、审批、Agent/插件状态。
- Commander：拆任务、并行取证、根因置信度、审批请求、报告。
- WeCom/事件时间线；人工接管/暂停。
- **G8c**：一次模拟故障从告警到根因/审批闭环；UI 可操作；R2 无审批不可执行。

**Sprint 4（W27–28）：安全与发布**

- 无 shell 验收；工具 schema/路径/命令白名单；插件只读；审计。
- 并发/超时/重试/降级；性能与故障演练。
- 备份/升级手册；**G8 / P1.6 发布**。

## 6. 功能落地顺序（纵向切片）

按“用户能完成一件事”排序，而不是按技术层：

1. 登录 → 选租户 → 工作台 → 角色视角。
2. 新建会话 → 调用 mock 工具 → 审批 → 审计。
3. Zabbix 查询 → 工具卡片 → 证据/产物。
4. Prometheus/Grafana/Alertmanager → 告警到诊断。
5. 数据库/主机连接器 → 指标分析/巡检。
6. 场景运行 → 报告 → 分享。
7. 创造模式 → 生成连接器 → 沙箱 → 审核 → 灰度 → 转正。
8. 数据沉淀 → 本地优先查询。
9. 文档/对话/平台运行/插件数据 → 知识草稿 → 审核 → 引用。
10. 消息中心 → 企业微信/邮件/Webhook 审批与告警。
11. 长任务 → 无人值守巡检 → 告警/接管。
12. Commander → 告警 → 事件 → 插件/Client 证据 → 根因 → 审批 → 事件报告。
13. Desktop 薄客户端。

## 7. 验收矩阵

| 领域 | 验收标准 |
|---|---|
| 租户隔离 | 跨租户读写/会话/知识/数据/任务全部拒绝；RLS + 运行时双层 |
| 身份/角色 | LDAP + 本地管理员；多角色权限并集；视角切换不越权 |
| 审批 | R2+ 无审批不能执行；审批拒绝/超时/回执可审计 |
| 连接器 | 9 个契约测试；只读；超时/401/429/5xx 错误映射；凭据不泄露 |
| 创造模式 | dsh `cordis` preset + 创造模式 skills + `plugin_manager`/`cordis_inspect_*` 全走通；Cordis connector bundle 在沙箱 profile 安装、inspect、测试；审核/灰度/回滚有效 |
| 场景 | 3 个场景端到端；报告可追溯证据；分享不放大权限 |
| 数据沉淀 | 自动建库；本地优先/回源；清理 dry-run；配额；来源标注 |
| 知识 | 四类来源；不自动发布；审核/版本/引用；租户 ACL；历史回溯审计 |
| 消息 | 企业微信/邮件/Webhook；失败重试；站内信兜底；审批回执 |
| 长任务 | 检查点/心跳/恢复；无人值守巡检；告警去重；人工接管；不假成功 |
| Commander | fork/裁剪 dsh-superagent；每租户实例；Incident/Evidence/Hypothesis/Approval；无 shell；ConnectorExecutor；根因/审批/事件报告 |
| dsh 兼容 | 固定版本；7 项契约测试；升级灰度 72h；可回滚 |
| 性能 | 登录 < 2s；首 token < 5s；连接器查询 P95 < 3s；知识检索 < 1s（目标值，验收前校准） |
| 运维 | docker-compose 一键起；备份恢复演练；升级/回滚手册 |

## 8. 团队与分工

| 角色 | 人数 | 负责 |
|---|---|---|
| Tech Lead / 后端 | 1 | 架构、控制面、Commander 核心评审、发布 |
| 后端 A | 1 | 身份/RBAC/审批/审计/模型/租户；Commander 事件/审批 API |
| Runtime/集成 | 1 | dsh、Runtime Agent、连接器框架、9 个连接器、创造模式 sandbox/profile、Commander 运行实例 |
| 全栈 B | 1 | 场景、创造模式、知识智能体、长任务、Commander 事件域 |
| 前端 | 1 | 19 屏 + 事件列表/指挥台、主题、交互、Desktop 壳 |
| QA/安全 | 1 | 隔离/越权/契约/性能/故障注入/Commander 无 shell 审计/发布 |
| 产品/设计 | 0.5 | 验收、文案、交互细节 |

> 6.5 FTE 是 48 周计划的前提。实际少于 6.5 FTE，按缺口顺延，不裁功能。

## 9. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| dsh 版本/API 变化 | 运行时不可升级 | 固定版本、契约测试、灰度 72h、镜像回滚 |
| 创造模式安全 | 生成越权/外发连接器 | 沙箱 profile、测试门禁、代码审查、出站 allowlist、租户管理员审核、不可自动发布 |
| dsh 创造模式 API/技能漂移 | 生成产物不可安装 | 固定 dsh 版本；`cordis` preset/skills/plugin_manager 契约测试；技能/模板版本化；不 fork |
| 连接器认证差异 | 联调拖期 | 每类先做最小探针；只读账号；fixture；按连接器独立验收 |
| ClickHouse/DB SQL 风险 | 注入/慢查询 | 参数化模板、只读账号、超时/行数/字节上限、临时 SQL 审批 |
| 长任务状态丢失 | 假成功/重复告警 | 任务实体 + 检查点 + 心跳 + 租约 + 幂等；不依赖会话常驻 |
| 企业微信私有部署 | 回调不通 | 验签/解密/防重放；出站 allowlist；站内信兜底；联调清单 |
| 知识隐私 | 对话/文档泄露 | 租户开关、脱敏、来源 ACL、知识管理员审核、审计 |
| Commander fork 维护 | 上游研究代码漂移 | fork 后 pin 版本、只保留 core/effects/policy 骨架、契约测试、保留 MIT/归属 |
| Commander 无 shell 效率 | 长尾诊断变慢 | 复合诊断、并行取证、插件下推、证据缓存、预授权 R1、审批与取证并行 |
| 告警风暴/事件串行 | 大量 Ticket、Eval 排队 | 去重/分组/严重度/批量 Eval/优先级；一 Incident 多 Ticket 并行 |
| 每租户 commander 资源 | 多实例成本 | 每租户独立小实例；共享池仅试用；按活跃事件弹性 |
| dsh-superagent API/版本漂移 | 事件指挥不可用 | 固定 dsh 版本；fork 后跑 core/prompt/effect/client 契约测试 |
| Server Agent root 权限 | 误操作/提权/横向 | 动作注册表、路径白名单、无裸 Shell、R2 审批、root 审计、威胁测试 |
| Agent 伪造/重放指令 | 危险动作执行 | mTLS + 签名信封 + nonce/过期 + 动作白名单 + 租户/主机二次校验 |
| Agent 快照占满磁盘 | 影响业务 | 最长 1 天、1GB/2% 硬上限、80/95% 分级清理、停高频并告警 |
| Agent 兼容性/覆盖 | 老旧系统/非 systemd 落地慢 | Linux/systemd 优先；非标准环境降级为只读/人工；不承诺全发行版 |
| 范围蔓延 | 48 周失控 | 本文范围基线 + 变更单；不裁功能，只顺延 |
| 人力不足 | 关键路径阻塞 | 6.5 FTE 前提；缺口提前暴露；连接器/页面/Commander 可并行 |

## 10. 变更控制

- 任何新增功能进入**变更单**：影响的工作流、里程碑、人力、验收。
- 不通过“先简化/后补”降低已确认功能；只允许调整顺序或顺延。
- P1 期间冻结范围；P1.5 开始前只允许 P0/P1 暴露的架构性变更。

## 11. Server Agent 新增主线（P2-A/P2-B，在 P1.6 之后）

Server Agent（每台服务器一个 Go Agent）是新增的跨平台、强安全属性主线，**不塞进 P1/P1.5/P1.6 的 28 周**。

### 11.1 已确认实施边界

| 项 | 确认结果 |
|---|---|
| 首发 OS | Linux（systemd）优先；Windows/macOS 后续 |
| Agent 形态 | **轻量 LLM Agent**：Go 单二进制内置 Eino ADK Agent Runtime；不是纯主机代理，也不是 dsh on host |
| 运行权限 | **默认 root 运行**（采集/部署需要），但必须做动作级权限门控；CLI 以普通用户运行 |
| 纳管 | 一次性令牌 + CSR + 设备证书；网段/标签自动批准，其他人工；未知主机隔离 |
| 模型 | 模型对接信息服务端下发；Agent 不持有厂商 Key；推理走服务端 LLM Gateway |
| 日常巡航 | 本地调度检查 OS/应用/服务/容量/日志/配置；异常立即进入本地分析并上报 |
| 部署/升级 | P2-B 支持受控部署/升级：签名制品、变更单、预检、canary、回滚 |
| 本地快照 | **最长保留 1 天**；不做长期本地趋势 |
| 写能力 | 诊断默认只读；部署/升级为 R3，必须审批、维护窗口、签名制品、回滚点 |

### 11.2 轻量 Agent Runtime（P2-A）

客户端不是“把 dsh 塞进每台主机”，而是基于 **CloudWeGo Eino ADK** 的轻量 Agent Runtime：

```
Wake（调度/异常/服务端指令）
  → Context（应用画像/快照/最近事件/指令/知识）
  → Plan（LLM Gateway，OpenAI 兼容 tool calling）
  → Act（类型化工具：诊断/采集/部署）
  → Verify（健康检查/证据校验）
  → Report（证据/结论/状态）
  → Sleep（无任务不调模型）
```

- **模型**：只调服务端 LLM Gateway；Agent 不持有 Key；会话级短时模型 token；租户配额/审计在服务端。
- **工具**：只暴露 `internal/tools` 注册表；R0/R1 只读，R2/R3 审批；无任意 Shell。
- **上下文**：本地快照、应用画像、最近事件、服务端指令；默认 8–16k token 预算，不做本地向量库。
- **预算**：单次任务最大步数 8–12、Token/时长/工具调用上限；超限暂停并上报。
- **空闲**：没有巡检/异常/指令时不调用模型，CPU <1%，避免“每台机器一直烧 Token”。
- **为什么选 Eino**：Go 原生、Apache-2.0、13k+ stars、活跃维护；ADK 内置 ReAct、Tool、HITL interrupt/resume、callbacks、compose Graph，正好覆盖巡航/分析/审批；core 轻、按需引入 eino-ext 模型适配；不选 dsh on host（Node 太重）、LangChainGo（抽象/依赖面大、非 Agent 优先）、ADK Go（要求 Go 1.26.10、较新、偏云原生）。**约束**：pin Eino v0.9.x；只用 ChatModelAgent + 自定义 Tool + compose Graph，禁用 DeepAgent shell/python 工具；policy/executor/审批由 OpsAgent 薄封装。

### 11.3 root 权限门控

- `opsagentd` root；`opsagent` CLI 普通用户；Unix socket + peer credentials。
- 动作注册表：`action_id`、风险、允许路径/二进制、参数 schema、超时、输出上限、是否可降权。
- **不执行裸 Shell**：不拼 `sh -c`；直接 exec 白名单二进制；env 清洗。
- 读路径白名单：禁止 `/etc/shadow`、私钥、完整环境变量、docker socket、全盘遍历。
- 写路径最小化：除 `/var/lib/opsagent` 与授权部署目录外不写；R2/R3 需服务端签名 + 审批 + 回滚。
- R0/R1 本地只读；R2/R3 本地 CLI 不能批准。
- root 审计：euid/uid、command_id、动作、参数哈希、结果、耗时。
- 安全验收：伪造/重放/错发租户/路径穿越/命令注入/日志提示注入/本地越权/密钥泄露。

### 11.4 日常巡航与异常分析

- 本地调度：平台健康、OS 基础、应用服务、端口/连接、日志错误签名、容量/证书/配置漂移。
- 异常：本地规则先聚合；达到阈值/基线偏离时启动轻量 LLM 分析（工具只读），生成证据包 + 结论/置信度 + 建议。
- 上报：异常事件带应用/DC、指标窗口、日志签名、配置 hash、快照引用；服务端 Commander 可继续派工。
- 不在本地自动修复；R2+ 回到服务端审批。

### 11.5 本地快照保留（最长 1 天）

| 频率 | 数据 | 本地保留 |
|---|---|---|
| 5s | CPU/内存/load/磁盘 IO/网络/TopN 进程 | 1 小时 |
| 30s | 服务状态、端口、连接、应用健康 | 6 小时 |
| 5m | 配置哈希、日志错误签名、依赖变化 | 24 小时 |
| 按需 | 线程栈、日志尾、连接详情、配置片段 | 24 小时 / 单次 200MB |

- 总磁盘上限 `min(1GB, 磁盘2%)`；80% 清旧高频，95% 停高频并告警。
- 不做 7 天本地趋势；趋势由服务端汇总/时序库承担。
- 采集器 CPU/内存/IO 限额纳入 G9 验收。

### 11.6 P2-A（12 周）：可用 LLM Agent

| 工作流 | 交付 |
|---|---|
| Agent 核心 | Go 单二进制、systemd、root daemon + 权限门控、CLI（普通用户）、SQLite/ring |
| 安装/配置 | `opsagent install --server --tenant --join-token-file --ca-cert --cpu-quota --memory-max`；IP 明文，认证字段 AES-256-GCM 加密 |
| 资源限额 | systemd cgroup：CPUQuota/MemoryMax/GOMEMLIMIT/Tasks/IO；空闲 CPU<1%、RSS<100MB |
| Agent Runtime | Eino ADK ChatModelAgent + 自定义 Tool + compose Graph；LLM Gateway 客户端；上下文/预算/验证/报告 |
| 注册/身份 | join token、CSR、证书轮换/吊销、租户/主机绑定、未知主机隔离 |
| 受控发现 | OS/服务/应用/部署/配置/日志/运维工具客户端；证据 + 置信度 |
| 归属/知识 | IP/主机名/CMDB → 应用系统/数据中心；本地知识缓存；冲突复核 |
| 日常巡航 | 本地调度、异常规则、只读 LLM 分析、证据上报 |
| 服务端 | Agent Gateway、Registry、CMDB 绑定、Profile/Policy/技能包、Agent 管理页 |
| CLI | 本地对话、只读诊断、模型走服务端 Gateway、离线降级 |

**G9**：10 台混合 Linux 安装/注册/发现/采集/巡航；CLI 安装参数正确落盘；IP 明文、认证字段密文、无私钥泄露；CPU/内存限额压测通过；LLM 分析只读；跨租户拒绝；root 门控/路径白名单通过。

### 11.7 P2-B（8 周 + 2 周 contingency）：可排障、可部署 Agent

| 工作流 | 交付 |
|---|---|
| 签名诊断 | 指令信封、nonce/过期、动作白名单、幂等、结果签名 |
| 诊断动作 | 线程栈、日志尾、端口/连接、配置片段、服务状态、快照 |
| 总控闭环 | Commander 下发、Host/Connector/Specialist 并行、证据回传、根因/审批/报告 |
| 受控部署 | 签名 DeployOrder/制品、预检、停止/替换/启动、健康检查、canary、回滚 |
| 部署边界 | R3、变更单、维护窗口、双人审批、只允许注册动作；不做任意 Shell |
| 安全加固 | 伪造/重放/错发/注入/越权/模型提示注入测试；灰度/审计 |
| 体验 | 异常时间线、Agent 详情、指令/证据页、部署记录/回滚入口 |

**G10**：真实异常从上报 → Commander 派发 → Agent 证据 → 根因闭环；一次受控部署从审批 → 预检 → canary → 健康检查 → 回滚演练；R2/R3 无审批不可执行。

### 11.8 P3 路线图（不纳入 P2）

- 虚拟化/存储/网络 Agent：插件化，共用注册/策略/指令/审计协议。
- 更复杂的部署策略（多机编排、数据库变更、蓝绿/金丝雀扩展）。
- 可选受限本地推理/离线 Agent；不默认开启。
- 更细的本地趋势/预测、跨设备协同。

### 11.9 与现有路线的关系

- 串行（推荐）：P1.6 结束后启动 P2-A/P2-B；P1/P1.5/P1.6 的 28 周不变，Agent 再 +20 周。
- 并行：需额外约 2.5 FTE（Agent 后端/系统/安全/模型），且与 P1.5 联调、安全评审竞争；不推荐在 6.5 FTE 内硬塞。
- 不把 Agent 塞进 P1.5 的 8 周；发现、模型循环、root 门控、部署闭环无法在该周期内可靠完成。
设计详情：`docs/design/03-server-agent.md`；汇报材料：`docs/design/server-agent-report/index.html`。

## 12. 执行基线（已确认）

1. **计划**：12 + 8 + 8 + 12 + 8 周、6.5 FTE、G0–G10、验收矩阵，按本文执行。
2. **创造模式**：完整继承 dsh `cordis` 创造模式；OpsAgent 只提供 Connector SDK、授权 skill/模板、Studio 编排、沙箱/审核/灰度，不另造生成器。协议由 Connector SDK 覆盖 REST/OpenAPI、JSON-RPC、SOAP/WSDL、gRPC；私有加密协议/私有 SDK 走人工插件。
3. **Commander 融合**：选择性 fork/裁剪 dsh-superagent；每租户一个 commander 实例；**无 shell**，类型化工具 + Host Agent 签名动作 + R0–R3；UI 在 OpsAgent Web 原生重做。
4. **Server Agent**：按最优建议在 P1.6 之后串行执行 P2-A（12 周）+ P2-B（8 周）；P1/P1.5/P1.6 不变；不并行加塞。
5. **节奏**：先拆 P1 的两周 Sprint 任务级计划（文件、接口、测试、提交粒度）；任务级计划确认前不写产品代码。

## 13. 需求追踪矩阵（全量检核）

本轮按对话逐项检核 **71 个需求点**，发现并补齐 10 个原计划表述缺口：默认浅色/时间窗口、180 天审计、MCP、模型 BYOK/双协议、平台管理员不可读会话正文、数据 30 天/5GB 与查询策略、文档 ACL/格式、消息路由/模板、P1.5 连接器扩展、知识采信顺序/不自动发布；并按新确认完成 1 个实现方式调整：创造模式改为完整继承 dsh `cordis`，不另造生成器；新增 Commander 融合 8 项。以下每项均有阶段、落点和验收，**当前无未覆盖项**。

### A. 平台、身份与体验

| # | 需求 | 阶段 / 任务 | 验收 |
|---|---|---|---|
| A1 | 多用户、多租户、数据隔离 | P0/P1；租户/RBAC/RLS；G1/G4 | 跨租户读写/会话拒绝 |
| A2 | LDAP 登录 + 本地管理员，无 OIDC | P1 Sprint 1；身份模块 | LDAP bind、待分配、本地紧急登录；无 SSO |
| A3 | 平台管理员分配租户 + 初始角色 | P1 Sprint 1；成员/角色 | 分配后可登录；租户管理员可维护 |
| A4 | 9 个内置角色、一个用户多角色、视角切换 | P1 Sprint 1；角色/RBAC | 权限并集；视角不放大权限 |
| A5 | 只有租户管理员配置插件、按角色授权 | P1 Sprint 1/2；RBAC + 连接器 | 非租户管理员无法改插件/授权 |
| A6 | 工具级 RBAC 双重校验 | P1 Sprint 2；工具网关 | 会话权限 + 租户角色双校验 |
| A7 | 审批、审计、180 天保留 | P1 Sprint 1/5；审批桥/审计 | R2+ 无审批不可执行；180 天热存+归档 |
| A8 | 平台管理员不能看租户会话正文 | P0/P1；权限与审计 | 跨租户/正文读取被拒；break-glass 也不允许 |
| A9 | OpenAI 兼容 + Anthropic；平台 Key + 租户 BYOK | P1 Sprint 1；模型 Provider | 双协议流式/工具调用；BYOK 可用 |
| A10 | docker-compose 私有化 | P1 Sprint 5；部署 | 一键起、备份恢复、升级回滚 |
| A11 | 主题四模式、默认浅色、07:00–19:00 时间窗口、用户/租户默认 | P1 Sprint 1；外观 | 四模式；默认浅色；无 FOUC；跨午夜；设备时区；用户可设默认；不增加自定义配色/高对比模式 |
| A12 | Web 19 屏 IA 与交互 | P1/P1.5；WS5 | P1 范围页面 + P1.5 全页面 |
| A13 | Desktop 薄客户端 | P1.5 Sprint 2；Desktop | 登录/会话/审批/密钥链 |

### B. 连接器、场景、创造模式、分享

| # | 需求 | 阶段 / 任务 | 验收 |
|---|---|---|---|
| B1 | 9 个标准连接器 | P1 Sprint 2/3；WS3 | 契约 + 只读 + 隔离测试 |
| B2 | 通用 HTTP 连接器 | P1 Sprint 2/4；manifest | REST/JSONPath、分页/重试/脱敏 |
| B3 | MCP 白名单 | P1 Sprint 2；MCP | 平台登记、工具发现、禁止租户 stdio |
| B4 | 3 个场景：巡检、指标分析、故障诊断 | P1 Sprint 3/4；场景 DSL | 手动/定时、报告、证据 |
| B5 | 报告与证据 | P1 Sprint 3/4；报告页 | 结论可追溯到工具/证据 |
| B6 | 完整继承 dsh `cordis` 创造模式，自动生成 Cordis connector bundle | P0/P1 Sprint 4/5；Studio + WS4 | `cordis` preset/skills；`plugin_manager` 安装；`cordis_inspect_*` 验证；bundle 可安装 |
| B7 | 创造模式沙箱与测试门禁 | P1 Sprint 4/5 | 一次性 `opsagent-studio` profile；测试未过不能发布；不能出沙箱 |
| B8 | 分享：个人→角色→租户→平台 | P1 Sprint 4/5；分享审批 | 租户管理员审批；权限不放大 |
| B9 | 平台共享由租户管理员审核 | P1 Sprint 5 | 平台管理员只治理/下架，不设审批前置 |
| B10 | 场景/连接器发布与复用 | P1；场景中心 | 发布、安装、版本、审计 |
| B11 | OpsAgent Connector SDK/模板/skill | P1 Sprint 4；WS4 | `defineConnector/defineTool`；模板/skill；契约测试 |

### C. P1.5：数据、知识、消息、长任务（Commander 在 P1.6）

| # | 需求 | 阶段 / 任务 | 验收 |
|---|---|---|---|
| C1 | 插件数据自动建库 | P1.5 Sprint 1；Plugin Store | manifest 声明→自动 DDL；插件不能执行任意 DDL |
| C2 | 本地优先、过期/缺失回源 | P1.5 Sprint 1；查询层 | `local_first` 生效；stale/fallback 标注 |
| C3 | 默认 30 天 / 单连接器 5GB | P1.5 Sprint 1；清理任务 | 超限停同步/告警；dry-run |
| C4 | 四种查询策略 | P1.5 Sprint 1；数据集配置 | 本地优先/实时优先/仅本地/仅实时 |
| C5 | 自动清理（TTL/行数/配额） | P1.5 Sprint 1 | 清理审计；不删知识/审计/审批 |
| C6 | 知识四类来源 | P1.5 Sprint 1/2；知识智能体 | 插件数据（每日增量+每周深度）/文档/对话/平台运行均出草稿 |
| C7 | 文档格式 + 严格 ACL | P1.5 Sprint 1；文档接入 | PDF/Word/Excel/MD/HTML/CSV；ACL/版本/删除同步；不接飞书/外部文档平台 |
| C8 | 对话租户开关 + 历史回溯 90 天 | P1.5 Sprint 2 | 租户统一开关；不自动回溯；显式任务审计 |
| C9 | 知识管理员审核、永不自动发布、可由普通成员担任；仅租户内共享 | P1.5 Sprint 2/3 | AI 只出 draft；发布/变更需审核；知识管理员不附带运行权限；租户隔离 |
| C10 | 来源采信顺序 | P1.5 Sprint 2/3 | 文档≈平台运行 > 插件派生 > 对话；冲突留证 |
| C11 | 知识版本、引用、复审 | P1.5 Sprint 3 | `knowledge.search` 引用；旧版可用；反馈复审 |
| C12 | 企业微信（私有部署）/邮件/Webhook/站内信，渠道插件 | P1.5 Sprint 1/2；消息中心 | 审批卡片、回调、送达回执、站内信兜底；渠道插件化 |
| C13 | 消息路由/模板/静默/升级/重试 | P1.5 Sprint 1/2；消息中心 | 按角色/值班路由；静默只发高优；重试 |
| C14 | 长任务/无人值守巡检 | P1.5 Sprint 1/2/3；tasks | 检查点/心跳/恢复；平台+系统巡检；告警去重；接管 |
| C15 | Commander（Super Agent） | P1.6；事件指挥 | 队友/任务板/证据/人工接管/知识草稿 |
| C16 | P1.5 连接器扩展 | P1.5 Sprint 2；WS3 | K8s/Kafka/ES/OpenSearch/MongoDB/Nginx/RabbitMQ |

### D. Server Agent（P2-A/P2-B）

| # | 需求 | 阶段 / 任务 | 验收 |
|---|---|---|---|
| D1 | 每台服务器一个 Go Agent | P2-A；Agent 核心 | 单二进制 + systemd + CLI |
| D2 | 默认 root + 权限门控 | P2-A/P2-B；11.2 | 动作注册表/路径白名单/无裸 Shell/R2 审批 |
| D3 | 自动纳管/通信 | P2-A；Enrollment/Gateway | 令牌+CSR；自动/人工批准；mTLS 出站 |
| D4 | 发现 OS/服务/应用/运维工具客户端 | P2-A；discovery | 只读、限路径/预算；证据+置信度 |
| D5 | 应用部署方式/配置/日志位置 | P2-A；discovery | systemd/容器/裸进程；配置/日志可追溯 |
| D6 | IP/主机名→应用系统/数据中心 | P2-A；CMDB/本地知识 | 多候选/冲突可审计；离线可用 |
| D7 | 常驻采集、快照最长 1 天 | P2-A；collector | 5s 1h/30s 6h/5m 24h；1GB/2% 上限 |
| D8 | 异常自动上报 | P2-A；异常管道 | 证据包；去重/背压；不告警风暴 |
| D9 | CLI 对话 + 从服务端拉取技能/工具包 + 模型配置服务端下发 | P2-A；CLI/策略 | 普通用户 CLI；无模型 Key；离线降级；签名包 |
| D10 | 服务端下发排障指令 | P2-B；Command Bus | 签名/过期/nonce/动作白名单/幂等 |
| D11 | 服务端自动纳管/注册表 | P2-A；Gateway/Registry | 主机/应用/DC/版本/状态/隔离 |
| D12 | 服务端总控 + 工具插件并行 | P2-B；Control Agent | 主机证据 + Zabbix/Prom/DB 关联 |
| D13 | 虚拟化/存储/网络 Agent 预留 | P3；插件协议 | 共用注册/策略/指令/审计 |
| D14 | 受控部署/升级 | P2-B；变更执行 | 变更单/签名制品/预检/canary/回滚 |
| D15 | 安全鉴权/防伪造/防重放 | P2-B；11.2/协议 | 伪造/重放/错发/注入/越权测试 |
| D16 | 自巡航边界、不对系统/业务造成影响 | P2-A；资源/采集 | 默认只读；CPU/内存/IO 限制；预算；降级 |
| D17 | Agent 管理 UI | P2-A/P2-B | 列表/详情/指令/证据/策略 |
| D18 | Eino ADK 轻量 Agent Runtime | P2-A；11.2 | Eino ADK；模型走 Gateway；工具/预算/验证；空闲不调模型 |
| D19 | 日常巡航 + 异常分析 | P2-A；11.4 | 本地规则 + 只读 LLM 分析；证据/置信度/上报 |
| D20 | 受控部署/升级 | P2-B；11.7 | 签名 DeployOrder/制品；预检/canary/健康/回滚；R3 |

### E. 质量与计划

| # | 需求 | 阶段 / 任务 | 验收 |
|---|---|---|---|
| E1 | 与 dsh 兼容、不 fork | P0/G0；5.6 契约 | 7 项契约测试；升级灰度/回滚 |
| E2 | 性能基线 | P1/P1.5/P1.6；验收 | 登录/首 token/查询/检索/事件派发/证据目标 |
| E3 | 备份恢复/升级回滚 | P1 Sprint 5/P1.5/P1.6 | 演练通过；手册齐备 |
| E4 | G0–G10 | 全程 | G0–G10 逐项签字 |
| E5 | 12 + 8 + 8 + 12 + 8 周、6.5 FTE | 全程 | 人力不足则顺延，不裁功能 |
| E6 | 变更控制/不裁功能 | 全程 | 变更单；范围调整可追溯 |

### F. Commander 融合（P1.6/P2-B）

| # | 需求 | 阶段 / 任务 | 验收 |
|---|---|---|---|
| F1 | 选择性 fork/裁剪 dsh-superagent；每租户一个 commander | P1.6；WS8 | 保留 core/effects/outbox/policy；无 GitHub/Feishu 编码假设；租户隔离 |
| F2 | Incident / Evidence / Hypothesis / Approval | P1.6；事件域 | 事件时间线、证据引用、竞争假设、审批可追溯 |
| F3 | 无 shell、类型化工具、R0–R3 | P1.6；安全验收 | Commander/Worker 无 bash/write；动作 schema；R2 无审批不可执行 |
| F4 | Alert/Agent/人工 Source + 去重/分组/严重度 | P1.6；Source | 告警风暴可抑制；一 Incident 多 Ticket |
| F5 | ConnectorExecutor 并行调度运维插件 | P1.6；Executor | Prom/Zabbix/ClickHouse/DB 并行；结果证据化；超时可审计 |
| F6 | HostAgentExecutor + 根因闭环 | P2-B；Executor | 签名诊断、客户端证据、超时恢复、根因/审批/报告 |
| F7 | OpsAgent Web 原生事件指挥 UI | P1.6；前端 | 事件列表/时间线/任务板/证据板/假设/审批/Agent 状态 |
| F8 | 执行效率/安全/平台目标验收 | P1.6/P2-B | 标准故障 MTTR、无 shell、审计、租户隔离、故障演练 |

**检核结论**：按当前对话范围，P1/P1.5/P1.6 的需求已全部落到 Sprint、验收和 Gate；Server Agent 单列为 P2-A/P2-B；P3 只保留部署/升级与虚拟化/存储/网络 Agent 蓝图。当前没有“未落点”的已确认功能。

## 14. 计划补强（正式开发前）

### 14.1 P0 任务级清单（2 周）

| # | 任务 | 产出 |
|---|---|---|
| P0-1 | dsh 固定版本、profile/bundle 启动、升级/回滚演练 | 版本/兼容性报告 |
| P0-2 | SDK create/prompt/resume/event、会话恢复 | SDK 契约样例 |
| P0-3 | defineTool 注册、R0–R3、审批 allow/deny/超时 | 工具/审批矩阵 |
| P0-4 | OpenAI 兼容/Anthropic 至少一个、流式/tool calling | 模型兼容性报告 |
| P0-5 | 每租户 runtime + capability token + 跨租户拒绝 | 隔离测试报告 |
| P0-6 | 创造模式沙箱 + plugin_manager + cordis_inspect | 创造模式 PoC |
| P0-7 | 长任务检查点/心跳/恢复 | 恢复测试报告 |
| P0-8 | Eino spike：ChatModelAgent + 自定义 Tool + HITL + 单二进制体积/RSS | Eino 选型结论 |
| P0-9 | cgroup v2 限额 + 配置加密/TPM + join token 传参 | Agent 安全报告 |

**P0 出口**：以上全部有证据；任一项失败，P1/P2 相关范围不得开工。

### 14.2 进度缓冲

- P1.6：**8 周基线 + 2 周 contingency**；W24 未通过 fork PoC 即启用。
- P2-B：**8 周基线 + 2 周 contingency**；部署制品/回滚未在 P2-A 末期冻结即启用。
- 48 周是基线；最坏 **52 周**，不裁功能只顺延。
- 6.5 FTE 无额外 buffer；若 P1.6/P2-B 同时触发 contingency，需 +0.5–1 安全/后端或接受顺延。

### 14.3 部署制品规范（P2-B v1）

- 支持：**systemd 管理的应用 + tar.gz 制品 + manifest**（app/version/artifact digest/stop/start/health/rollback）。
- 不支持：任意 Shell 脚本、未签名制品、数据库变更、K8s 编排（P3）。
- 流程：DeployOrder 签名 → digest 校验 → 预检 → 备份/回滚点 → 停/换/启 → 健康检查 → canary → 放量 → 报告。
- 失败：自动停止/回滚；保留证据；人工接管。
- 后续：rpm/deb、容器、蓝绿/多机编排 P3。

### 14.4 Sprint 契约冻结

- 每个 Sprint 开始前 2 天冻结：OpenAPI、ERD、SSE 事件、错误码、权限、测试夹具。
- 未冻结不写代码；跨 Sprint 变更走变更单，不直接改对方表。
- P1.6/P2-A/P2-B 的 API/ERD 必须在上一阶段结束前完成评审。

### 14.5 测试夹具与环境

- 连接器：每个只读 mock + 超时/错误/空结果 + 凭据轮换。
- dsh：固定版本、mock model、审批/工具矩阵。
- Eino：fake ChatModel、tool call、HITL、预算超限。
- Agent：Rocky/Ubuntu/Debian VM、root/普通用户、cgroup v2、断网、磁盘满。
- 部署：签名/未签名制品、digest 错误、canary 失败、回滚。
- 知识/消息：四来源、ACL、版本发布/回滚、WeCom 验签/邮件/Webhook。

### 14.6 人力与职责

| 角色 | 职责 | 阶段 |
|---|---|---|
| 平台后端 A | 控制面/租户/RBAC/审计 | P1 |
| 平台后端 B | dsh 运行时/工具/审批 | P1 |
| 连接器/场景 | 9 连接器/3 场景 | P1 |
| 前端 | 19 屏 + 事件列表/Agent 页 | P1–P2 |
| 全栈/Commander | P1.6 事件域/UI | P1.6 |
| OS/Agent | Eino/安装/资源/部署 | P2-A/B |
| 安全/QA | 威胁模型/渗透/故障注入 | 全程 |

### 14.7 Definition of Ready

- 本 Sprint 的 OpenAPI/ERD 已冻结。
- 页面/组件映射已确认。
- 测试夹具/环境已就绪。
- 安全边界（R0–R3/审批/租户）已明确。
- 依赖的上游 Gate 已通过。

### 14.8 计划变更

- 任何范围增加必须走变更单，说明对 48 周/52 周的影响。
- 不裁功能；只能顺延或加人。
- Gate 失败不允许“带病进入下一阶段”。
