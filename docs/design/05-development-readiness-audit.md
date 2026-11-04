# 正式开发前校验（Platform Readiness Audit）

> 日期：2026-11-03  
> 状态：**历史审计（2026-11-03 的开发前时点）**；当前代码已进入 0.3.2 交付，最新状态见 [`2026-11-04-acceptance-status.md`](plans/2026-11-04-acceptance-status.md) 与 [`FINAL-DELIVERY.md`](../FINAL-DELIVERY.md)。  
> 范围：平台架构、功能点、功能设计、前端/后端契合、技术选型、计划与验收。  
> 结论（历史）：**P1 编码 No-Go；P0 技术验证 Conditional-Go。** 还有 7 个阻塞项必须在 P1 前关闭（B7 已在本次审计中关闭）。

## 1. 结论摘要

| 维度 | 结论 | 说明 |
|---|---|---|
| 平台架构 | **基本完整** | 控制面/运行时/连接器/数据/知识/Commander/Host Agent 都有落点 |
| 功能覆盖 | **主功能覆盖，少数设计未同步** | 创造模式设计文档/Studio、Commander 事件列表、部署制品策略仍有缺口 |
| 前后端契合 | **P1 基本对齐；P1.6 不足** | 19 屏覆盖 P1/P1.5；`incidents.html` 缺失，`studio.html` 仍是旧 manifest 流程 |
| 技术选型 | **方向成立，待 P0 验证** | dsh 服务端 + Eino 客户端 + Go/gRPC/SQLite/systemd 的组合合理；Eino v0.9.x 需 spike |
| 计划 | **有条件合理** | 48 周基线 / 52 周最坏；P1.6、P2-B 各 +2 周 contingency；6.5 FTE 仍紧 |
| 安全 | **设计有边界，验证不足** | root 门控、无 shell、mTLS/签名、字段加密都有；cgroup/TPM/加入令牌泄漏未实测 |
| 可以开工吗 | **不可以** | G0 未执行；创造模式、Commander、Eino、资源配置、部署制品均未验证 |

**一句话：架构和范围能支撑开发，但“设计已收敛、技术已证明”还不成立；先做 P0/G0，再关闭设计缺口。功能契约见 `06-functional-coverage-and-contracts.md`，计划补强见 `01-development-plan.md` §14。**

## 2. 功能点覆盖矩阵

| 领域 | 需求/功能 | 设计落点 | 阶段 | 状态 |
|---|---|---|---|---|
| 身份 | LDAP + 本地管理员、无 OIDC | 00 §4/§7、01 P1 | P1 | 覆盖 |
| 多租户 | RLS、运行时/卷/凭据/审计隔离 | 00 §7/§12、01 P1 | P1 | 覆盖 |
| 角色 | 9 角色、多角色并集、视角不放大 | 00 §4、02 矩阵 | P1 | 覆盖 |
| 工作台 | 会话、工具、审批、产物、SSE | 00 §6、Sprint 1 | P1 | 覆盖 |
| 主题 | 浅色/深色/系统/时间；默认浅色 | 00 §11、`appearance.html` | P1 | 覆盖 |
| 连接器 | 9 个 P1、6 个 P1.5、HTTP/MCP | 00 §8、02 | P1/P1.5 | 设计覆盖；fixture 未细化 |
| 插件数据 | 自动建库、本地优先、30 天/5GB、清理 | 00 §8、01 P1.5 | P1.5 | 覆盖 |
| 场景 | 巡检/指标分析/故障诊断、发布/共享 | 00 §9、02 | P1 | 覆盖 |
| 创造模式 | 完整继承 dsh `cordis`、Cordis bundle、沙箱、审核/灰度 | 01 P1、README | P1 | **设计文档/Studio 未完全同步** |
| 知识 | 四来源、审核、版本、引用、租户 ACL | 00 §10/§?、01 P1.5 | P1.5 | 覆盖 |
| 知识热更新 | 版本化索引、SSE/Redis 失效、下一 turn 生效、回滚 | 00、platform report | P1.5 | 覆盖 |
| 消息 | 企业微信/邮件/Webhook/站内信、审批卡片 | 00 §6.7、01 P1.5 | P1.5 | 覆盖 |
| 长任务 | 检查点/心跳/恢复、无人值守巡检 | 00 §6.7、01 P1.5 | P1.5 | 覆盖 |
| Commander | Incident/Evidence/Hypothesis/Approval、三类 Executor、无 shell | 00 §6.6、02、feasibility | P1.6 | 概念/计划覆盖；API/ERD/UI 列表缺 |
| Host Agent | Go、Eino ADK、root 门控、发现/巡航/诊断/部署 | 03、os-agent-tech、01 P2 | P2-A/B | 设计覆盖；Eino/部署待 P0 |
| Agent 资源 | CPUQuota/MemoryMax/GOMEMLIMIT/cgroup | 03 §10.2、os-agent-tech | P2-A | 覆盖；cgroup 实测缺 |
| Agent 安装 | CLI server/tenant/token/CA/cpu/memory | 03 §10.1、os-agent-tech | P2-A | 覆盖；token argv 风险需约束 |
| Agent 配置加密 | IP 明文、认证字段 AES-GCM | 03 §10.3、os-agent-tech | P2-A | 覆盖；TPM/key 丢失未实测 |
| Agent 部署 | 签名 DeployOrder/制品、canary/回滚 | 03 §13、01 P2-B | P2-B | 方向覆盖；制品格式/策略未细化 |
| 安全/审计 | 审批、审计 180 天、威胁模型 | 00 §11/§15、03 §7 | P1–P2 | 设计覆盖；威胁模型未正式签字 |
| 部署 | docker-compose、健康检查、升级 | 00 §13、01 P1 | P1 | 覆盖；compose 未实测 |
| 测试 | G0–G10、验收矩阵 | 01/02 | 全程 | 覆盖；连接器/Agent 测试夹具未细化 |

## 3. 架构一致性校验

### 3.1 已对齐

- **服务端**：控制面 + 每租户 dsh 运行时 + Runtime Agent + SDK JSON-RPC；不 fork agent-loop。
- **客户端**：Go `opsagentd` + Eino ADK Agent Runtime；模型走服务端 LLM Gateway；不把 dsh/Node 放到主机。
- **Commander**：P1.6 选择性 fork dsh-superagent；每租户实例；Connector/Host/Specialist Executor；无 shell。
- **连接器**：manifest → 工具注册 → R0–R3 → 审批；插件数据 `storage.datasets`。
- **通信**：Web SSE；Control↔Runtime mTLS；Gateway↔Host Agent mTLS 只出站；知识热更新 Redis/SSE。
- **数据**：PostgreSQL/pgvector、Redis、MinIO、Vault/KMS；租户 RLS。

### 3.2 不一致/未收敛

| # | 问题 | 影响 |
|---|---|---|
| A1 | `00-platform-design.md` §10 核心步骤已在本次审计改为 dsh cordis；但 `studio.html` 仍是旧交互 | 前端与创造模式后端契约仍需同步 |
| A2 | `design/studio.html` 仍是旧 manifest 生成交互 | 前端与创造模式后端契约不一致 |
| A3 | `incidents.html` 事件列表缺失，只有 `incident.html` 详情 | P1.6 UI 不完整 |
| A4 | `server-agent-report/index.html` 已加历史横幅，指向当前 Eino/Commander 材料 | 已关闭 |
| A5 | 19 屏原型 + 事件列表，但文档多处只写 19 屏 | 验收口径不统一 |
| A6 | `README` 原写“22 项确认决策”，已改为 20 项设计决策 | 已关闭 |

## 4. 前后端契合

### 4.1 已对齐

- 登录、工作台、会话、场景、报告、连接器、成员/角色、分享、平台管理、主题均有屏幕与 P1/P1.5 落点。
- 设计 token/组件可映射 React：AppShell、DataTable、ApprovalCard、EvidenceCard、Timeline。

### 4.2 缺口

- **Studio**：需要展示 dsh 创造模式会话、Cordis bundle、`plugin_manager` 安装、`cordis_inspect` 验证、沙箱 profile、审核/灰度；现在是 manifest 生成。
- **Commander**：缺事件列表、严重度/筛选、事件→Ticket 视图；`incident.html` 需补 Evidence/Hypothesis 交互。
- **Host Agent**：需要 Agent 详情、安装参数、资源限额、配置加密状态、巡航/异常/部署记录页面或面板。
- **API 契约**：P1 Sprint 1 有任务级契约；P1.2+ 连接器、场景、创造模式、知识、消息、长任务、Commander、Agent 的 OpenAPI/ERD 尚未逐 Sprint 细化。

## 5. 技术选型校验

| 技术 | 结论 | 风险/待验证 |
|---|---|---|
| dsh 0.2.x | 服务端运行时 | 版本 pin、SDK、审批、模型、沙箱、长任务恢复需 G0 |
| Eino v0.9.x | 客户端 Agent 框架 | v0.x API 变动；需 pin + `internal/agent/eino` 薄封装 + P0 spike |
| Go 1.24+ / CGO=0 | 单二进制 | Eino/依赖在目标发行版编译、体积、RSS 需实测 |
| gRPC/protobuf + mTLS | Agent 通信 | 证书轮换/重放/断网/代理需测试 |
| SQLite (modernc) + zstd | 本地存储 | 1 天/1GB/2% 限额、磁盘满、迁移需测试 |
| systemd/cgroup v2 | 资源限额 | cgroup v1 回退、`MemorySwapMax`、OOM 优先级需在 Rocky/Ubuntu 实测 |
| AES-256-GCM 字段加密 | 配置加密 | master key TPM/文件、AAD、轮换、丢失重注册需测试 |
| Eino + LLM Gateway | 本地推理 | 客户端无 Key；tool calling、流式、预算、超时应测试 |
| 部署执行器 | 部署/升级 | 制品格式（tar/rpm/容器）、systemd 应用、canary/回滚需细化 |

## 6. 计划合理性

| 阶段 | 周期 | 判断 |
|---|---|---|
| P0 | 2 周 | 必须做；G0 是硬门禁 |
| P1 | 12 周 | 9 连接器 + 创造模式 + 平台底座，偏紧 |
| P1.5 | 8 周 | 数据/知识/消息/长任务/Desktop，偏紧 |
| P1.6 | 8 周 + 2 周 contingency | Commander + 事件 UI + ConnectorExecutor；高风险，已加 2 周缓冲，仍建议 +0.5–1 FTE |
| P2-A | 12 周 | Eino/资源/安装/加密/巡航；合理但需 P0 结论 |
| P2-B | 8 周 + 2 周 contingency | 诊断 + 部署/回滚；偏紧，制品/策略要先冻结 |
| 合计 | 48 周基线 / 52 周最坏 | 不裁功能；以 Gate 顺延 |

- 6.5 FTE 没有 buffer；P1.6 和 P2-B 是两个最可能滑的阶段。
- 不能把“P2-A/B 12+8”当成已排期确认；需要资源与 Gate 复核。

## 7. 正式开发前阻塞项

| # | 阻塞 | 关闭条件 | 级别 |
|---|---|---|---|
| B1 | **G0 未执行** | dsh/SDK/工具/审批/模型/隔离/沙箱/长任务 7 项通过 | 阻塞 P1 |
| B2 | **创造模式 Studio 未同步** | `00` §10 已改；剩余 `studio.html` 改为 dsh cordis；G3 验收 | 阻塞 P1 创造模式 |
| B3 | **Commander 事件列表 UI 缺** | API/ERD/威胁模型已补（06 §9）；剩余 `incidents.html` + 字段级契约 | 部分缓解 |
| B4 | **P1.2+ API/ERD 未逐 Sprint 细化** | 已补家族级契约（06）；每个 Sprint 开始前仍须字段级冻结 | 缓解 |
| B5 | **Eino/LLM Gateway 未 spike** | Eino v0.9.x + 自定义 Tool + HITL + 单二进制实测 | 阻塞 P2-A |
| B6 | **资源限额/加密未实测** | cgroup v2、TPM/文件 key、token argv 风险、磁盘满测试 | 阻塞 P2-A |
| B7 | **旧 server-agent-report 口径冲突** | 已加历史横幅并指向当前材料 | **已关闭** |
| B8 | **P1.6/P2-B 周期无 buffer** | 已加 2+2 周 contingency；6.5 FTE 风险仍在 | 缓解 |

## 8. 正式开发 Gate

### P0/G0（必须先做）

1. dsh 固定版本启动/profile/bundle。
2. SDK create/prompt/resume/event。
3. `defineTool` + 审批 allow/deny。
4. OpenAI 兼容/Anthropic 至少一个。
5. 每租户隔离 + capability token。
6. 创造模式沙箱 + Eino/客户端工具边界。
7. 长任务/检查点/恢复。

### 设计 Gate（P1 前）

- 创造模式：Cordis bundle/Studio/审核/灰度设计定稿。
- P1.6：Incident/Evidence/Hypothesis/Approval API/ERD/威胁模型 + `incidents.html`。
- P2-A：Eino spike、资源限额、安装 CLI、配置加密、cgroup/TPM 测试。
- 所有 Sprint：OpenAPI/ERD、页面/组件映射、测试夹具。

### 工程 Gate

- CI、compose、数据库迁移、LDAP mock、E2E 环境。
- 6.5 FTE 与 P1.6/P2-B 排期复核。
- 安全评审：root 门控、无 shell、加密、供应链。

## 9. 已就绪/可确认

- 48 周总路线、P1/P1.5/P1.6/P2-A/P2-B 顺序。
- 多租户/RLDAP/多角色/审计/主题。
- 9 连接器、场景、插件数据、知识四来源/热更新、消息、长任务。
- dsh 服务端 + Eino 客户端 + Commander 的职责边界。
- Host Agent 的 root 门控、无 shell、mTLS/签名、1 天快照。
- 安装 CLI/资源限额/字段加密的设计方向。

## 10. 校验结论

**不是“设计全部完成、可以正式开发”，而是“主架构和主功能覆盖，关键缺口明确”。**

- **No-Go**：P1 编码、P1.6 Commander、P2-A Eino 实现。
- **Conditional-Go**：P0 技术验证；关闭 B1–B6 后再开 P1。
- 旧 `server-agent-report` 只能作为历史材料，不能作为当前 Agent 口径。
- 当前没有写产品代码、没有 G0 证据；不能把计划当成已验证。

## 11. 建议顺序

1. 先做 P0/G0（2 周），产出兼容性/风险报告。
2. 同步 `studio.html` 的 dsh cordis 交互，并补 `incidents.html` 事件列表（B2/B3 剩余 UI）。
3. 做 Eino + cgroup + 配置加密 spike（B5/B6）。
4. 冻结 P1 Sprint 1 API/ERD，确认旧报告历史横幅（B7 已关闭）。
5. 复核 P1.6/P2-B 资源（B8），再批准 P1 开工。
