# OpsAgent 设计交付物（v0.3.2）

本目录是运维智能体平台的**设计 + 开发计划交付**，用于确认产品全景、权限模型、智能体底座、插件与分享机制、UI 方向，以及开发落地路径。**平台已完成 0.3.2 交付，代码、验收材料与用户手册见：**

- [最终交付说明](../FINAL-DELIVERY.md)
- [G0–G10 正式验收包](plans/2026-11-04-acceptance-status.md)
- [发布说明](../RELEASE.md)
- [用户手册](../../apps/web/src/content/user-manual.md)

## 当前状态（2026-11-05）

```text
平台代码：完成
自动化验收：221 passed | 3 skipped
E2E：14 passed
Go Agent：通过
OCSP：标准响应 + 实时验证
流量级 canary：控制面 + Nginx 配置生成
正式签字：外部环境/人员待签
```

## 建议阅读顺序

1. **总体设计**：[`00-platform-design.md`](00-platform-design.md)  
   需求闭环、角色权限、功能全景、技术架构、连接器/场景/分享、多租户、模型接入、部署、首期范围、已确认决策。
2. **开发落地路径**：[`01-development-plan.md`](01-development-plan.md)  
   12 周 P1 + 8 周 P1.5 + 8 周 P1.6 Commander + 12 周 P2-A + 8 周 P2-B、G0–G10、工作流/依赖、团队、风险、验收矩阵。
3. **功能矩阵**：[`02-feature-matrix.md`](02-feature-matrix.md)  
   20 项设计决策 + P1/P1.5/P1.6 功能逐项落点、页面与验收。
4. **Server Agent 设计**：[`03-server-agent.md`](03-server-agent.md)  
   每台服务器一个 Go Agent + Eino ADK 轻量 Agent Runtime：初始化发现、日常巡航、异常分析、受控部署/升级、能力边界、mTLS/签名指令、排障闭环、P2-A/P2-B 路线。
5. **Server Agent 当前汇报**：[`platform-report/os-agent-tech.html`](platform-report/os-agent-tech.html)、[`platform-report/agent-commander.html`](platform-report/agent-commander.html)  
   技术选型（Eino）、安装/资源限额/配置加密、巡航/异常/部署、与 Commander 协同；旧 [`server-agent-report/index.html`](server-agent-report/index.html) 仅作历史材料。
6. **UI 原型**：[`../../design/login.html`](../../design/login.html)  
   19 屏可点击 HTML，从登录开始；同一目录下并排显示。截图在 `design/_shots/`。
7. **调研一：dsh 能力地图**：[`research/harness-capability-map.md`](research/harness-capability-map.md)  
   dsh 运行时、扩展点、模型、持久化、认证、部署、A/B/C 复用方案与集成建议。
8. **调研二：连接器与场景**：[`research/ops-connectors-and-scenarios.md`](research/ops-connectors-and-scenarios.md)  
   20 个连接器、manifest schema、工具契约、9 个场景、分享状态机、创造模式安全约束。
9. **调研三：dsh-superagent 融合可行性**：[`research/dsh-superagent-feasibility.md`](research/dsh-superagent-feasibility.md)  
   事件指挥/派工/证据/根因的复用边界、HostAgent/Connector Executor、每租户 commander、12–16 周落地建议。
10. **P1 Sprint 1 任务级计划**：[`plans/2026-11-03-p1-sprint-1.md`](plans/2026-11-03-p1-sprint-1.md)  
    G1 纵向切片：workspace、契约、租户/RBAC、LDAP/本地管理员、审计、dsh runtime、mock 工具/审批、Web 登录/主题、E2E。
11. **历史就绪评审（已被 05/06 取代）**：[`04-predevelopment-readiness.md`](04-predevelopment-readiness.md)  
    平台能力、前后端契合、计划合理性、G0/P1.6 缺口与开工前动作。
12. **平台全景汇报（HTML）**：[`platform-report/index.html`](platform-report/index.html)  
    整个平台的功能、服务端/客户端 Agent 架构、通信、知识热更新、场景/创造、消息/长任务/Commander、路线图与创新点；配套 [`agent-commander.html`](platform-report/agent-commander.html) 协同/排障示例、[`os-agent-tech.html`](platform-report/os-agent-tech.html) OS Agent 技术选型与落地。
13. **历史开发前校验（2026-11-03 时点）**：[`05-development-readiness-audit.md`](05-development-readiness-audit.md)  
    平台架构/功能覆盖/前后端契合/技术选型/计划一致性与当时的阻塞项；当前状态见验收包。
14. **功能覆盖与契约**：[`06-functional-coverage-and-contracts.md`](06-functional-coverage-and-contracts.md)  
    功能域→页面→API→数据→验收；Sprint 契约冻结门、测试夹具、待补设计。
15. **计划补强**：[`01-development-plan.md`](01-development-plan.md) 第 14 节  
    P0 任务级清单、P1.6/P2-B 各 2 周 contingency、部署制品规范、Sprint 契约冻结、人力/RACI。

## 当前结论（已确认）

- **智能体底座**：dsh 作为独立 agent runtime（每租户一进程/容器 + 独立 `DSH_HOME`），平台用 SDK JSON-RPC 驱动；只新增 `opsagent` bundle 与 `tool-*` 插件，不 fork agent-loop。
- **多租户**：控制面 PostgreSQL `tenant_id + RLS`；运行时、卷、凭据、审计、出站代理均按租户隔离；平台管理员默认不读会话正文。
- **插件/场景**：标准连接器 + 通用 HTTP + AI 创造模式 + MCP；统一 R0–R3 风险与审批；场景默认角色可用，租户共享由租户管理员审批，平台共享也由租户管理员审核后进入平台目录。
- **插件数据沉淀（已确认）**：插件声明数据集、平台自动建库；读本地优先、写实时、过期回源；按 TTL/行数/配额自动清理，结果标注来源与新鲜度。
- **知识管理（已确认）**：四类来源——插件数据（每日增量+每周深度钻取）、知识文档（PDF/Word/Excel/MD/HTML/CSV）、用户对话（租户统一开启，脱敏后抽取）、平台运行产物——自动抽取为草稿，知识管理员审核后发布；租户内共享、租户隔离，Agent 只引用已发布知识。
- **多角色（已确认）**：管理身份 + 多个职能角色；权限取并集，视角切换调整导航/首页/场景/消息订阅，不放大权限。
- **Commander（P1.6）**：选择性 fork/裁剪 dsh-superagent；每租户一个实例；Incident/Evidence/Hypothesis/Approval；无 shell，类型化工具 + 签名主机动作 + R0–R3；OpsAgent Web 原生事件指挥台。P2-B 接 Host Agent 完整根因闭环。
- **消息中心（已确认）**：站内信 + 企业微信（私有部署，默认渠道，渠道插件）+ 邮件 + Webhook；审批、事件、巡检、知识待审统一收口。
- **模型**：OpenAI 兼容（chat/completions + responses）与 Anthropic Messages 均由 dsh `llm-pi-ai` 覆盖；平台做 Provider、路由、配额、密钥托管。
- **主题（已确认）**：只有浅色 / 深色 / 跟随系统 / 时间自适应四种；用户可设默认，默认浅色；时间自适应默认 07:00–19:00 浅色、其余深色，随设备时区。
- **首期**：P1 Web + LDAP/本地管理员 + 多角色 + 9 个连接器 + 场景/完整创造模式/审批/审计（12 周）；P1.5 数据沉淀、知识、消息（企业微信/邮件/Webhook）、长任务/无人值守巡检、Desktop（8 周）；P1.6 Commander connector-only 事件指挥（8 周）；P2-A/P2-B 客户端 Agent 与完整根因闭环。

## 已确认的关键决策

1. 复用路线：**C**（独立运行时 + SDK + 薄 bundle），不 fork。
2. 平台共享：**租户管理员审核**后进入平台目录，平台管理员只做治理。
3. 隔离：生产独立运行时，试用共享池。
4. 首期连接器：Zabbix / Prometheus / Grafana / Alertmanager / ClickHouse / MySQL / PostgreSQL / Redis / SSH。
5. 创造模式：**纳入 P1，8 步完整流水线**；P1 周期 12 周。
6. Commander：**P1.6 选择性 fork/裁剪 dsh-superagent**，每租户一个实例，无 shell；P2-B 接 Host Agent 完整根因闭环。
7. 身份：LDAP + 本地管理员，**不接 OIDC**。
8. 消息：企业微信（私有部署）/ 邮件 / Webhook，钉钉/飞书暂不接入。

完整 20 项决策见总体设计第 15 节。

## 原型说明

- `design/` 下每个 HTML 文件是一屏，互相有真实链接；`tokens.css` / `app.css` 是设计系统，`icons.svg` 是图标。
- 视觉方向：浅色运维控制台为默认，深色共用同一套语义 token；低饱和中性色 + 信号色，密集但可读的表格与卡片。
- 主题设置页：`design/appearance.html`；默认浅色工作台：`design/home.html`；深色预览：`design/home-dark.html`。
- 新增能力页：`design/data-store.html`（插件数据沉淀）、`design/knowledge.html`（知识中心）、`design/messages.html`（消息中心/企业微信/邮件/Webhook）、`design/incident.html`（Commander 事件指挥台）、`design/tasks.html`（长任务/无人值守巡检）。
- 原型不是最终前端代码；确认 IA 和交互后，再进入 React 实现。
