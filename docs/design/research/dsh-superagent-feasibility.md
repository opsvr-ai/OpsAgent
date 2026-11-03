# dsh-superagent 融合可行性分析

> 对象：`dsh-superagent-prototype/`（MIT，研究原型，非官方产品）
> 目标：故障时由总调度智能体统一指挥客户端 Agent 快速排障，并调度运维平台插件确认根因。
> 结论：**可融合，但要“选择性融合”，不能作为一个 bundle 直接接入。**

## 0. 结论先行

| 判断 | 结论 |
|---|---|
| 概念契合度 | **高**：Source → Trigger → Thread → Eval → Ticket → Assignment 的编排模型，天然适合“故障 → 事件 → 任务 → 派工 → 证据” |
| 代码直接复用度 | **低到中**：项目是“单 GitHub 仓库的编码 Agent”，不是运维事件指挥；Source/Executor/UI/安全都需要改 |
| 推荐方式 | **Fork/裁剪出 `opsagent-commander` 核心**，保留领域状态机、Effects/Outbox、Policy/Mandate；替换 Source、Executor、prompt、UI、安全 |
| 多租户 | **不要改造原项目为多租户**；按 Plan C **每租户一个 commander 实例**，独立 SQLite/stateDir |
| 客户端 Agent 调度 | 现有 `DshExecutor` 不适合；新增 `HostAgentExecutor`，用签名指令与异步回执驱动客户端 Agent |
| 运维插件调度 | 现有主/工 Session 可挂工具；新增 `ConnectorExecutor` 或把插件工具注入 commander/worker，并建证据模型 |
| 安全 | **阻塞项**：原 worker 预设允许无审批 shell/write；必须移除，改为类型化工具 + R0–R3 审批 |
| 工作量 | PoC 约 2 周；核心改造 6–8 周；主机 Agent/根因闭环 4–6 周；合计 **12–16 周** |
| 落地建议 | P1.5 做“connector + 事件指挥”最小闭环；P2-B 接客户端 Agent 做完整排障；不要挤进 P1.5 的 8 周做全量 |

### 评分卡

| 维度 | 分数 | 理由 |
|---|---:|---|
| 领域模型契合 | 5/5 | Trigger/Thread/Ticket/Assignment 与故障排障高度同构 |
| 状态机/持久化可复用 | 4/5 | Engine/Effects/Outbox/恢复机制成熟 |
| 可直接运行 | 2/5 | GitHub/Feishu、单团队、编码 worker |
| 运维域扩展 | 2/5 | 无 Incident/Evidence/Approval/HostAgent/Connector |
| 安全基线 | 1/5 | worker 无审批 shell；必须重写 |
| 多租户 | 1/5 | 单 SQLite/单 profile；建议每租户实例 |
| 生产就绪 | 1/5 | README 明确 research prototype |


## 1. 这个项目是什么

README 明确：它是**面向一个 GitHub 仓库的主动编码 Agent**，以 DSH bundle 形式运行；监听 GitHub/Feishu，评估请求，创建 Ticket，每个 Ticket 在自己的 DSH Session/目录里执行，最后回复或提 PR；Web panel 展示需要人的事项。它是研究原型，不是生产软件。

核心领域（`docs/001-domain.md`）：

```
Source → Trigger → Thread → Eval → Decision/Mandate → Ticket → Assignment → Executor Session → Report → Channel
```

- Source：事件流（GitHub/Feishu）。
- Trigger：一个不可变事件。
- Thread：事件时间线；同一 Thread 一次只跑一个 Eval。
- Eval：准入 + 模型研判，产出 accept/stop/ignore/unavailable。
- Mandate：授权范围、强度、策略版本。
- Ticket：被授权的工作单元。
- Assignment：Ticket 绑定到一个 Executor 实例。
- Executor：每个 Ticket 一个 DSH Session + 本地目录。
- Channel：回写 GitHub/Feishu。

它还有：Policy/Mandate、Effects/Outbox 持久队列、SourceRegistry、MasterAssessor、主/工两套 Session、面板、重启恢复。

## 2. 与 OpsAgent 故障指挥的映射

| dsh-superagent | OpsAgent 故障指挥 | 契合度 |
|---|---|---|
| Source（GitHub/Feishu） | 告警源/客户端 Agent 异常/人工事件/变更事件 | 中：协议可扩展，但现有实现绑定 GitHub/Feishu |
| Trigger | 一条告警、异常上报、人工报障 | 高 |
| Thread | 一次故障/事件时间线（按 fingerprint/服务/主机聚合） | 高，但需告警去重/分组 |
| Eval | 事件定级、是否建事件、派哪些任务、是否需审批 | 高，但需新 prompt/工具 |
| Mandate/Policy | 角色、租户、允许来源、R0–R3 授权 | 高，但缺“审批”实体 |
| Ticket | 一个排障任务（查指标、查日志、查主机、验证假设） | 高 |
| Assignment | 派给客户端 Agent/插件分析器/专家 Session | 需要新 Executor 类型 |
| Executor Session | 专家分析会话 | 中：可复用 reasoning，但不能直接跑本地 shell |
| Report | 证据/结论/置信度 | 中：需结构化 Evidence，不仅是文本 |
| Channel | 企业微信/事件时间线/Web | 低：需新 Channel |
| Panel | 事件指挥台/任务板/证据板 | 中：交互模式可借鉴，页面需重做 |

**关键判断**：它的“工单/派工/回执”骨架可以复用，但 **Ticket 不等于 Incident**。建议新增 `Incident` 聚合在 Ticket 之上：Incident 持有严重度、影响面、时间线、证据、假设、审批、根因；Ticket 只是 Incident 下的排障任务。

## 3. 可复用性矩阵

| 模块 | 代码/设计 | 复用判断 | 说明 |
|---|---|---|---|
| `src/core` 领域状态机 | Trigger/Thread/Eval/Ticket/Assignment | **高** | 事务、幂等、恢复、阶段机都值得保留 |
| `Engine`/`Effects`/`Outbox` | 同步事务 + 持久队列 + 重试 | **高** | 适合派发客户端命令/插件查询/消息，避免“假成功” |
| Policy/Mandate | 准入、规则、版本、重验证 | **中高** | 可做租户/角色授权；需另加人工审批 |
| SourceRegistry/SourceKind | 插件化事件源 | **中** | 可新增 AlertSource/AgentSource；现有 setup/字段/渠道绑定 GitHub/Feishu |
| `DshExecutor` | 每 Ticket 一个 Session/目录/worker slot | **中低** | 适合专家分析，不适合远程主机执行；需新 Executor |
| 主 Session 工具 | `orchestrator_route/eval/read/reply/note` | **中** | 可复用派工语义；需加 `incident_*`/`host_*`/`connector_*` |
| 主/工 prompt | 编码/仓库/PR 语境 | **低** | 必须重写为“事件指挥/排障/证据” |
| Worker 预设 | bash/write/edit/web 等无审批 shell | **低（阻塞）** | 不能进入生产；改为类型化工具 + R0–R3 |
| 面板 | 单团队 GitHub/Feishu 面板 | **低到中** | 信息架构可借鉴，需重做多租户事件 UI |
| Setup/部署 | GitHub/Feishu CLI、单 profile、SQLite | **低** | 需改为租户 mTLS/配置/凭据 |
| 多租户 | 无 | **无** | 建议每租户一个实例，不改 schema |
| 客户端 Agent | 无 | **无** | 新建 HostAgentExecutor/命令协议 |
| 运维插件工具 | 无 | **无** | 接 Connector SDK/工具注册 |
| 证据/根因/审批 | 无 | **无** | 新建聚合与 UI |

## 4. 必须新增的 OpsAgent 能力

### 4.1 领域对象

- **Incident**：租户、严重度、状态、影响服务/主机、开始/结束、指挥官、Ticket 列表、假设、根因、审批、知识链接。
- **Evidence**：来源（host/connector/log/metric/change）、原始引用、摘要、哈希、时间、置信度、可见范围。
- **Hypothesis**：候选根因、预期证据、已验证/反驳、置信度、竞争假设。
- **Approval**：R2/R3、审批人、作用域、过期、审计。
- **ClientAgent / Command**：主机、证书、能力、命令、回执、证据。

### 4.2 新 Source

- Alertmanager / Zabbix / 客户端 Agent 异常 / 人工事件 / 变更事件。
- 告警去重/分组：按 fingerprint、服务、主机、时间窗合并；避免一个故障生成几十个 Ticket。
- Thread key：`incident:<fingerprint>` 或 `service:<id>:<window>`。
- Source scope/policy 要能按租户、服务、严重度过滤。

### 4.3 新 Executor

| Executor | 用途 | 行为 |
|---|---|---|
| `HostAgentExecutor` | 派客户端 Agent 做只读诊断 | 签名指令、异步回执、心跳/超时、证据、无 shell |
| `ConnectorExecutor` | 调度 Zabbix/Prom/ClickHouse/DB 插件 | 并行查询、超时、结果证据化 |
| `SpecialistExecutor` | 专家 Session 分析日志/指标 | 复用 DSH worker，但工具只读、受控 |
| `HybridExecutor` | 一个 Ticket 需要多源证据 | 聚合 Host/Connector/Specialist 结果 |

原 `Executor` 端口只有 `start/deliver/stop`，适合扩展成多种实现；`DshExecutor` 可保留为 SpecialistExecutor 的基础。

### 4.4 主调度智能体（Commander）

主 Session 不应只“路由工单”，应成为**事件指挥官**：

- 工具：`incident.open/close`、`incident.assign`、`evidence.add/query`、`host.diagnose`、`connector.query`、`hypothesis.update`、`rootcause.confirm`、`approval.request`、`notify`。
- 职责：定级、拆任务、并行派发、汇总证据、维护假设、确认根因、发起审批、输出事件报告。
- 不直接执行 shell；所有动作走类型化工具/签名指令。
- 需要**证据板**：不是让模型自由总结，而是“结论 → 证据引用 → 置信度”。

### 4.5 事件指挥 UI

- 事件列表：严重度、影响面、状态、指挥官、SLA。
- 事件详情：时间线、任务板、证据板、假设、审批、客户端 Agent 回执、插件证据。
- 任务板：每个 Ticket/Assignment 的状态、负责人（Host/Connector/Specialist）、依赖、结果。
- 人工接管：暂停、改派、确认根因、发起变更。

## 5. 关键缺口与风险

### 5.1 安全（阻塞）

- 原项目 `dsh-superagent-worker` 预设包含 `bash/pwsh/write/edit`，**以 operator OS 用户运行且无审批**；这对 OpsAgent 不可接受。
- 主 Session 也有 shell（读文件/命令）和写工具限制，但仍需重写。
- 必须移除任意 shell，改为：
  - 类型化工具（host.diagnose/connector.query/...）；
  - 主机侧由客户端 Agent 执行签名命令；
  - R0–R3 与人工审批；
  - 路径/命令白名单、超时、输出上限、审计。
- 不能把“worker 有 shell”当成“反正有容器”；生产不建议依赖容器兜底。

### 5.2 单租户

- 单 SQLite、单 stateDir、单 panel、单 team 配置；没有 `tenant_id`。
- 不建议改造成多租户 schema（工作量大、易漏隔离）。
- 建议 **每租户一个 commander 实例**：独立 `DSH_HOME`/stateDir/SQLite/凭据/出口；平台控制面按租户路由事件。
- 这与既有 Plan C（每租户独立 runtime）一致。

### 5.3 GitHub/Feishu 绑定

- Source、Setup、Channel、Prompt、环境变量、UI 都带 GitHub/Feishu 假设。
- 需要新增 AlertSource/AgentSource/IncidentSource/WeComChannel，删掉 GitHub/Feishu 代码或降为可选插件。
- `SourceKind` 扩展点足够，但 setup fields、threadContext、channel 需要按新源重写。

### 5.4 事件模型不足

- 没有 Incident、Severity、Evidence、Hypothesis、RootCause、Approval、SLA。
- 原 Ticket 是一段编码工作；OpsAgent 的 Incident 需要多任务、并行证据、人工审批、根因置信度。
- 建议新建 Incident 聚合，Ticket 只做任务，避免把严重度/证据塞进 Ticket 导致模型混乱。

### 5.5 编排语义差异

- 原项目强调“主 Session 不做技术调查，worker 做”；OpsAgent 需要指挥官**做跨源关联和根因判断**。
- 原项目一 Thread 一次 Eval，告警风暴可能串行；需要告警聚合/批量 Eval/优先级。
- 原项目 Ticket 结束条件是 PR 状态；OpsAgent 是根因确认/处置完成/事件关闭。
- 原项目 Channel 是评论/回复；OpsAgent 需要企业微信、事件时间线、Web 实时。

### 5.6 dsh 版本兼容

- 原型 `engines.dsh: ^0.2.1-alpha.2`，依赖 Cordis `4.0.5-alpha.1`；与现有运行时 `0.2.2-alpha.2` 接近，但 alpha 版本不能假定兼容。
- 需要 pin 版本，跑契约测试：bundle 加载、Session 创建/恢复、工具注册、Effect 队列、Prompt/skill、client panel。
- 研究原型，MIT；建议 fork/ vendor，保留 LICENSE，不直接依赖 upstream main。

### 5.7 安全方案评估：移除 shell，改类型化工具

**方案**：Commander/Worker 不保留任意 shell；所有动作走类型化工具。客户端 Agent 的执行也走签名动作协议（`host.diagnose` 等），R0/R1 自动、R2/R3 审批。模型不能拼接命令，不能直接读任意文件。

| 维度 | 影响 | 判断 |
|---|---|---|
| 安全性 | 去掉“提示注入 → shell”链路；动作白名单、参数 schema、路径/命令限制、签名指令、审计；攻击面显著收敛 | **强正向** |
| 执行效率 | 标准排障更快（复合诊断、并行、缓存、结构化结果）；长尾/未知问题比 shell 慢，需要新增动作或插件 | **可控**；用复合工具/并行/预授权 runbook 抵消 |
| 平台目标 | 符合多租户、审计、可回滚、知识沉淀；避免“AI 在生产上执行任意命令” | **强正向** |
| 灵活性 | 不能临时执行任意命令；需要动作注册表持续扩展 | 以“受控动作 + 人工 break-glass”替代 |
| 审批延迟 | R2 需要人等，可能拉长 MTTR | 证据收集与审批并行；常见 R1 预授权；R2 异步通知 |
| 实现成本 | 工具/动作/审批/证据 schema 增多 | 一次性成本，长期可维护性更高 |

**建议方案**：

1. **三层工具**：
   - T0 只读：host status/metrics/log tail/port/connection/config hash，connector query；自动执行。
   - T1 复合诊断：`host.diagnose`、`plugin.triage`、`evidence.bundle`；自动执行，内部并行。
   - T2 低危写：重启服务、日志级别、清理临时文件；签名指令 + 人工审批 + 回滚点。
   - T3 变更：部署/升级/改配置；变更单 + 维护窗口 + 双人审批。
2. **Commander 只拿编排/只读工具**；不给写工具；R2+ 通过 `approval.request` 走平台审批。
3. **Host Agent 不提供任意 shell**；只提供动作注册表；需要新动作就新增 action/plugin，不能临时拼命令。
4. **人工 break-glass** 不进模型：由人通过现有 SSH/终端/跳板机操作，平台审计；不让 AI 以“紧急”为由获得 shell。
5. **效率补偿**：
   - 复合诊断一次采集多项，减少模型往返；
   - 多 Ticket/多 Executor 并行取证；
   - 插件查询下推、结果缓存、证据复用；
   - 常见故障预置 runbook/预授权 R1；
   - 审批与证据收集并行，不等审批才取证。

**结论**：采用“无 shell + 类型化工具 + 签名主机动作 + R0–R3”的方案。它会让长尾临时诊断略慢，但标准故障的 MTTR 更可控，且这是多租户生产平台必须承担的成本。不要把 shell 留作“效率捷径”。

### 5.8 UI 方案评估

| 方案 | 优点 | 问题 | 判断 |
|---|---|---|---|
| A 直接复用 dsh-superagent panel | 快，交互成熟 | DSH 单团队/GitHub/Feishu 语境；租户/权限/设计系统不匹配；等于嵌入另一套产品 | 不推荐 |
| B 在 OpsAgent Web 重做事件指挥 | 与现有 19 屏、租户/角色/主题/消息一致；可做证据板/审批/知识 | 需要前端投入 | **推荐** |
| C iframe/侧边嵌入 panel | 表面上快 | 登录/租户/路由/实时/审计割裂，后续不可维护 | 不推荐 |

**推荐 B：OpsAgent Web 原生事件指挥台**，只借鉴 dsh-superagent panel 的信息架构：

- 左侧：事件列表（严重度/影响面/状态/指挥官/SLA）。
- 主区：事件详情，Tab 为 **概览 / 时间线 / 任务板 / 证据板 / 假设 / 审批 / Agent 与插件 / 知识**。
- 右侧：当前假设、证据缺口、待审批、在线 Agent/插件、人工接管。
- 复用现有 `incident.html` 的事件指挥视觉；新增事件列表页；不引入第二套 UI 框架。

### 5.9 已采用的决策

1. **融合方式**：选择性 fork/裁剪 `opsagent-commander`，不直接接 bundle。
2. **部署**：每租户一个 commander 实例。
3. **安全**：无 shell；类型化工具；Host Agent 签名动作；R0–R3；人工 break-glass 不进模型。
4. **节奏**：P1.5 做 connector-only 指挥；P2-B 接 Host Agent；全量 12–16 周。
5. **UI**：OpsAgent Web 原生事件指挥台。

## 6. 建议的融合架构

```
平台控制面
  ├─ 事件路由（按 tenant/service）
  ├─ 租户 Commander 实例（每租户一个）
  │    ├─ Incident Engine（fork 自 dsh-superagent core）
  │    ├─ Commander Session（总调度智能体）
  │    ├─ Ticket/Assignment + Effects/Outbox
  │    ├─ Source Adapters：Alertmanager / Zabbix / Agent / 人工
  │    ├─ Executors：HostAgent / Connector / Specialist
  │    ├─ Evidence Board / Hypothesis / Approval
  │    └─ WeCom / 事件时间线 Channel
  ├─ 客户端 Agent Gateway（mTLS/签名命令）
  └─ 连接器/插件工具层（Zabbix/Prom/ClickHouse/DB/...）
```

一次故障：

```
告警/Agent 异常
  → Incident Thread（去重/分组/定级）
  → Commander triage：建 Incident，拆 Ticket
  → 并行 Assignment：
       HostAgentExecutor：查主机/进程/日志/连接
       ConnectorExecutor：查 Prometheus/Zabbix/ClickHouse/DB
       SpecialistExecutor：日志/指标关联分析
  → Evidence Board 汇总，Hypothesis 更新
  → Commander 根因确认（证据+置信度）
  → R2 审批/处置（如需要）
  → 事件报告/企业微信/知识草稿
```

## 7. 三种融合方式

| 方案 | 做法 | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| A 直接接入 | 把 dsh-superagent 作为 bundle 跑起来，改配置接告警 | 快 | GitHub/Feishu/编码模型完全不匹配；安全不可接受 | 仅做 PoC，不生产 |
| B Fork 裁剪 | fork 核心领域/Effects/Outbox/Panel，替换 Source/Executor/Prompt/UI | 保留成熟状态机，控制风险 | 需持续维护 fork | **推荐** |
| C 重写 | 只借鉴设计，用 OpsAgent 栈重写 | 最干净 | 12–16 周以上，重复造轮子 | 除非团队不接受 fork |

**推荐 B：Fork 一个 `opsagent-commander`**：

- 保留 `src/core`、`Effects`、`Outbox`、`Policy` 的骨架；
- 删除 GitHub/Feishu/编码专用代码；
- 增加 Incident/Evidence/Hypothesis/Approval；
- 增加 HostAgentExecutor/ConnectorExecutor；
- 重写 Commander/Worker prompt 和 UI；
- 每租户一个实例，mTLS/HTTP 接平台。

## 8. 落地阶段建议

### Phase 0：2 周 PoC

- fork 原型，跑起来；
- 用假 Alert Source 替换 GitHub；
- 用假 HostAgent/Connector Executor 验证：告警 → Incident → Ticket → 并行派发 → Evidence → 根因报告；
- 移除 worker shell，验证只读类型化工具；
- Gate：5 分钟内完成一次模拟故障闭环；无 shell；无跨租户。

### Phase 1：6–8 周 Commander 核心

- Incident/Evidence/Hypothesis/Approval；
- Alertmanager/Zabbix/Agent 三选一真实 Source + 人工事件；
- ConnectorExecutor（至少 Prometheus/Zabbix/ClickHouse 三个插件）；
- WeCom/事件时间线 Channel；
- Commander 工具与 UI（事件列表/详情/任务板/证据板）；
- 每租户实例、审计、R0–R3；
- Gate：真实告警 → 多插件证据 → 根因假设 → 人工确认。

### Phase 2：4–6 周 Host Agent 闭环

- HostAgentExecutor + 签名命令 + 心跳/超时/恢复；
- 客户端 Agent 证据回传；
- 根因确认/处置审批/知识草稿；
- 与 P2-A/P2-B Server Agent 对接；
- Gate：真实故障 → 主机证据 + 插件证据 → 根因 → 报告。

合计 **12–16 周**，不含 P1/P1.5 原有功能。

## 9. 与现有 20 周计划的关系

- **P1.5 的 Super Agent 8 周**不足以完成上述 12–16 周全量。
- 建议：
  - P1.5：做 **Phase 0 + Phase 1 的 connector-only 最小闭环**（事件指挥 + 插件证据 + 审批 + UI），不含 Host Agent。
  - P2-A：客户端 Agent 可用。
  - P2-B：接 HostAgentExecutor，完成客户端 Agent 调度与根因闭环。
- 如果要求 P1.5 就完成“客户端 Agent + 插件 + 根因”全量，需要把 P1.5 延长 4–6 周，或把部分 P1.5 功能后移；不建议裁功能。

## 10. 关键决策（需要你确认）

1. **融合方式**：采用 B（fork 裁剪），还是只把原型当参考、用 OpsAgent 重写？
2. **部署模型**：每租户一个 commander 实例（推荐），还是尝试改多租户？
3. **安全基线**：确认移除 worker shell，改为类型化工具 + 签名主机命令 + R0–R3 审批。
4. **落地位置**：P1.5 做 connector-only 最小闭环，P2-B 接客户端 Agent；是否接受？
5. **UI**：事件指挥台在 OpsAgent Web 重做，还是复用 dsh-superagent panel 的交互模式？

## 11. 最终建议

**可以融合，但只能选择式融合。**

- 它的价值是 **编排/授权/派工/恢复** 的骨架，不是 GitHub/Feishu 实现，也不是 worker shell。
- 最稳路径：fork 一个薄的 `opsagent-commander`，保留 core/effects/outbox/policy，替换 source/executor/prompt/UI，每租户一个实例。
- 先做 2 周 PoC 证明“告警 → 事件 → 并行证据 → 根因”，再决定是否投入 12–16 周产品化。
- 不要把它作为生产依赖直接安装；它明确是 research prototype。

### 不建议做的事

1. **不要把 dsh-superagent 作为生产 bundle 直接安装**：GitHub/Feishu/编码语境和安全基线都不匹配。
2. **不要保留 worker 的 bash/pwsh/write/edit**：它不是运维安全边界。
3. **不要把 Ticket 当 Incident**：会丢失严重度、影响面、证据、假设、审批。
4. **不要为了复用而把 SQLite/单 team 改成多租户**：每租户一个实例更稳。
5. **不要直接依赖 upstream main**：研究代码 + alpha API；fork 后 pin 版本、保留 MIT 许可与归属。

### 建议的下一步

- 先做一个 **2 周 PoC**（不接生产）：假 Alert Source + 假 HostAgent/Connector Executor + Incident/Evidence/Approval 最小闭环，验证“总调度 → 多源证据 → 根因”的价值。
- PoC 通过后再排 12–16 周产品化；与 P1.5/P2-B 的接口在 PoC 结束前不写死。

## 12. 证据与代码索引

- 项目说明：[`dsh-superagent-prototype/README.md`](../../../dsh-superagent-prototype/README.md)
- 领域模型：[`docs/001-domain.md`](../../../dsh-superagent-prototype/docs/001-domain.md)
- 执行/Worker 安全：[`docs/003-execution.md`](../../../dsh-superagent-prototype/docs/003-execution.md)
- 架构：[`docs/007-architecture.md`](../../../dsh-superagent-prototype/docs/007-architecture.md)
- 主 Session 工具：[`src/app/tools/main.ts`](../../../dsh-superagent-prototype/src/app/tools/main.ts)
- Executor 端口：[`src/core/ports.ts`](../../../dsh-superagent-prototype/src/core/ports.ts)
- DSH Executor：[`src/executor/dsh.ts`](../../../dsh-superagent-prototype/src/executor/dsh.ts)
- Source 插件契约：[`src/sources/kind.ts`](../../../dsh-superagent-prototype/src/sources/kind.ts)
- Bundle/preset：[`cordis.patch.yml`](../../../dsh-superagent-prototype/cordis.patch.yml)
- 依赖与 dsh 版本：[`package.json`](../../../dsh-superagent-prototype/package.json)

