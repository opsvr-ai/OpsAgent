# 指定 Agent 下发自然语言指令：设计

## Phase 1 已实现

```text
POST /api/agents/:agentId/instructions
GET  /api/agents/:agentId/instructions/:instructionId
```

- 操作员 Session 认证 + `agent.manage` 权限
- 目标 Agent 必须属于当前租户
- 离线超过 90 秒返回 409
- 自然语言由服务端规则规划为只读 `inspect`
- 写操作（重启/删除/安装等）返回 400
- 命令类型 `agent_instruction`，使用现有签名命令队列
- 指令原文、intent、requested_by、client_request_id 入库
- `clientRequestId` 幂等
- 创建指令写审计 `agent.instruction.create`
- Agent 只执行 `inspect`，不执行 Shell
- 查询接口返回 answer / evidence / toolsUsed

真机验证：

```text
created pending inspect
status completed
- 系统运行时长：2 小时 33 分钟（启动于 2026-11-04T11:19:21Z）
- 进程数：2
- 1 分钟负载：0.27
```

### Phase 2 已实现

Agent 详情页新增「自然语言」页签：

```text
目标固定为当前 Agent
  → 输入自然语言
  → 下发指令
  → 轮询执行结果
  → 展示 status / intent / answer / toolsUsed / evidence
```

- 目标 Agent 不可在输入框切换
- 只读提示
- 失败状态展示
- 结构化证据可展开
- 新增前端测试覆盖下发与结果渲染

### Phase 3 SSE 已实现

```text
GET /api/agents/:agentId/instructions/:instructionId/events
```

事件：

```text
status  当前指令状态
delta   回答分片
done    最终 answer / intent / evidence / toolsUsed
error   超时或错误
```

Web 详情页优先使用 `EventSource` 流式展示；无 EventSource 环境自动回退轮询。

真机验证：

```text
created 202
sse 200 text/event-stream
events: status... delta... done
answerLine: true
```

### 多 Agent 批量已实现

```http
POST /api/agents/instructions
{
  "agentIds": ["uuid-1", "uuid-2"],
  "instruction": "看看磁盘使用率"
}
```

- 1–8 台
- 全部必须属于当前租户
- 任意一台离线则整批拒绝 409
- 每台生成独立签名命令
- 统一审计 `agent.instruction.batch`
- Web 主机清单提供「批量指令」多选面板
- 批量结果逐台轮询状态，显示成功 / 失败 / 等待结果
- 支持导出 CSV（hostname / status / instructionId / answer）

### 超时治理

`AgentInstructionMonitor` 每分钟：

```text
type = agent_instruction
status = pending / dispatched
expires_at < now()
  → status = expired
  → completed_at = now()
```

Agent 拉取命令时也过滤过期命令，避免执行已过期签名指令。

### 取消指令

```http
POST /api/agents/:agentId/instructions/:instructionId/cancel
```

- 仅允许 `pending` / `dispatched`
- 状态改为 `canceled`
- 审计 `agent.instruction.cancel`
- Agent 执行中不能取消
- 详情页执行中显示「取消指令」

写操作审批仍未实现。

### 指令历史

```http
GET /api/agents/:agentId/instructions
```

- 最近 20 条指令
- 包含 instruction / status / intent / answer
- Agent 详情页「自然语言」页签展示历史
- 点击历史项加载对应结果

前端测试和 API 测试覆盖历史查询。

### 指令模板

```http
GET    /api/agents/instruction-templates
POST   /api/agents/instruction-templates
DELETE /api/agents/instruction-templates/:id
```

- 租户级模板
- 名称唯一
- 内置模板：运行时长、磁盘、服务端口、日志、应用系统健康
- Agent 详情页可选择模板、保存模板、删除最近模板

审计：

```text
agent.instruction.template.create
agent.instruction.template.delete
```

### Incident 证据联动

创建指令时可选：

```json
{
  "instruction": "检查磁盘为什么满了",
  "incidentId": "uuid"
}
```

完成后首次查询 / SSE 终态时：

```text
incident_evidence
  kind = agent_instruction
  包含 answer / evidence / toolsUsed / commandId

incident_events
  type = instruction_completed
```

使用 `incident_linked_at` 做幂等，重复查询不会重复写证据。

### Incident 页面直接发起

事件详情新增：

```text
Agent 指令排查
  → 自动加载事件所属应用系统的在线 Agent
  → 选择目标 Agent
  → 输入自然语言
  → 下发（自动携带 incidentId）
  → 显示状态与回答
  → 完成后刷新事件详情，证据自动出现
```

测试覆盖：

```text
Incident 证据写入
instruction_completed 事件
幂等 linked_at
Incident 指令列表与 CSV 导出
```

## 1. 目标

平台操作员在服务端选择**一台明确的 Agent 客户端**，输入自然语言指令，例如：

```text
看看磁盘为什么满了
检查订单服务为什么连不上数据库
最近 10 分钟有哪些异常日志
```

要求：

```text
服务端明确指定目标 Agent
  → 指令可追溯、可审计
  → 只读优先
  → 不能跨租户 / 跨应用系统误发
  → Agent 返回结构化证据和自然语言结论
```

## 2. 现状

已有：

- Agent 注册、心跳、命令队列
- Ed25519 签名命令信封
- `inspect` / `diagnostics` / `discovery` 等只读命令
- Agent CLI 的 `/api/agents/:id/chat` 自然语言问答
- Agent 详情页的人工命令（类型 + JSON）

缺口：

- `/api/agents/:id/chat` 只接受 `agentKey`，是 Agent 自己调用，不是操作员会话
- 没有“操作员选目标 Agent + 下发自然语言”的服务端接口
- 没有指令意图规划、审计和目标校验
- 没有自然语言指令的流式状态和结果展示

## 3. 推荐架构

```text
Web / API 操作员
  → POST /api/agents/:agentId/instructions
  → 服务端校验租户、权限、目标 Agent
  → 服务端意图规划（只读 allowlist）
  → 生成签名命令 agent_instruction
  → 现有 Agent 命令队列
  → 目标 Agent 执行只读检查
  → 结果签名回传
  → 服务端保存证据 + 组合自然语言回答
  → 返回 / SSE 流式输出
```

### 关键决策

**服务端做意图规划，Agent 做确定性执行。**

不把任意自然语言直接变成 Shell。服务端使用 DSH/Runtime 或规则把指令映射为：

```text
inspect(question)
diagnostics
discovery
snapshot
agent_query
```

Agent 只执行已签名的类型化命令；自然语言原文随命令保存，用于追溯和最终回答。

## 4. API 设计

### 创建设备指令

```http
POST /api/agents/:agentId/instructions
```

请求：

```json
{
  "instruction": "看看磁盘为什么满了",
  "mode": "read_only",
  "clientRequestId": "uuid",
  "timeoutSeconds": 30
}
```

响应 `202`：

```json
{
  "instructionId": "uuid",
  "commandId": "uuid",
  "agentId": "uuid",
  "hostname": "prod-web-01",
  "status": "pending",
  "intent": {
    "kind": "inspect",
    "readOnly": true,
    "confidence": 0.92
  }
}
```

### 查询结果

```http
GET /api/agents/:agentId/instructions/:instructionId
```

返回：

```json
{
  "status": "completed",
  "answer": "...",
  "evidence": {
    "intent": "inspect",
    "toolsUsed": ["disk", "log"],
    "result": {}
  },
  "commandId": "uuid",
  "createdAt": "...",
  "completedAt": "..."
}
```

### 流式状态

```http
GET /api/agents/:agentId/instructions/:instructionId/events
```

事件：

```text
status: 正在下发指令
status: 目标 Agent 已接收
status: 正在执行只读检查
delta:  ...
done
error
```

### 批量目标（后续）

```http
POST /api/agents/instructions
{
  "agentIds": ["..."],
  "instruction": "..."
}
```

首版只允许单 Agent，避免误发。

## 5. 数据模型

复用 `agent_commands`，增加：

```sql
ALTER TABLE agent_commands
  ADD COLUMN requested_by uuid REFERENCES users(id),
  ADD COLUMN instruction text,
  ADD COLUMN instruction_intent jsonb,
  ADD COLUMN client_request_id text;
```

约束：

```text
(tenant_id, agent_id, client_request_id) 唯一
```

记录：

```text
谁下发
发给哪台 Agent
自然语言原文
规划后的 intent
命令签名 / nonce / key id / 过期时间
状态 / 结果 / 完成时间
```

审计事件：

```text
agent.instruction.create
agent.instruction.completed
agent.instruction.rejected
```

## 6. 目标选择与权限

新增权限：

```text
agent.instruct
```

规则：

```text
必须已登录且选择租户
  → 只能选本租户 Agent
  → 校验 agent.manage 或 agent.instruct
  → targetAgentId 服务端解析，不接受浏览器传 agentKey
  → 离线 / 90 秒无心跳 Agent 返回 409
  → 超过 8 台批量默认拒绝
```

自然语言不能指定其他 Agent 绕过服务端校验。

## 7. 意图规划

服务端规划器：

```text
规则优先：
  uptime / 运行多久 → inspect
  磁盘 / 内存 / CPU / 进程 / 端口 / 服务 / 日志 → inspect
  应用系统健康 / 告警 / 根因 → platform 查询

规则无法匹配：
  → DSH Runtime 生成受限 plan
  → 只接受 allowlist 内的 kind
```

写操作：

```text
restart / kill / install / delete / chmod
  → 首版直接拒绝
  → 后续进入 R2/R3 审批，不直接下发
```

返回：

```json
{
  "kind": "inspect",
  "params": { "question": "..." },
  "readOnly": true
}
```

## 8. Agent 命令

新增类型：

```text
agent_instruction
```

payload：

```json
{
  "instruction": "看看磁盘为什么满了",
  "intent": { "kind": "inspect", "params": { "question": "..." } },
  "readOnly": true
}
```

Agent 处理：

```text
校验命令签名 / nonce / 过期
  → 根据 intent.kind 调用已有只读能力
  → 不允许 intent 中携带 shell 命令
  → 返回 answer + evidence + toolsUsed
```

首版只支持：

```text
inspect
diagnostics
discovery
agent_query
```

## 9. Web 交互

Agent 详情页新增：

```text
自然语言指令
  [目标 Agent：prod-web-01]（固定）
  [输入框]
  [发送]

状态：
  正在规划
  已下发
  Agent 已接收
  正在检查
  完成

结果显示：
  结论
  证据列表
  使用的工具
  对应 commandId
```

Agent 列表行增加：

```text
下发指令 → 当前行 Agent 固定为目标
```

不允许在输入框中通过自然语言切换目标。

## 10. 安全

- 操作员会话认证，不信任浏览器传入的 agentKey
- 租户隔离 + RLS
- 命令 Ed25519 签名、nonce、5 分钟过期
- 目标 Agent 由服务端解析
- 只读 allowlist，首版禁止写操作
- 指令长度限制 4000 字
- 每用户/每 Agent 限流
- 审计记录原文、目标、intent、结果状态
- Agent 返回结果签名校验
- 不允许指令直接注入 Shell
- 命令结果敏感字段脱敏后入库

## 11. 失败与超时

```text
目标 Agent 离线
  → 409 agent_offline

命令超过 5 分钟未下发
  → expired

Agent 执行失败
  → status=failed，返回 error

规划失败 / 写操作
  → 400 unsupported_instruction

超时
  → 202 pending + instructionId，前端继续查询
```

## 12. 实施阶段

### Phase 1：后端只读单 Agent

- 迁移：requested_by / instruction / intent / clientRequestId
- `InstructionService`
- `POST /api/agents/:agentId/instructions`
- Agent `agent_instruction` handler
- 审计、权限、目标校验
- 单测：跨租户拒绝、离线拒绝、写操作拒绝、签名校验

### Phase 2：Web 详情页

- 自然语言输入
- 目标固定 Agent
- 结果与证据展示
- 历史指令列表

### Phase 3：流式与批量

- SSE 状态
- 多 Agent 选择
- 审批动作
- 指令模板与收藏

## 13. 验收

```text
操作员可以选择 Agent A
  → 指令只到达 Agent A
  → Agent B 不收到
  → 结果带 commandId / evidence
  → 审计包含 requested_by 和 target

跨租户 Agent 返回 403/404
离线 Agent 返回 409
写操作被拒绝
伪造/过期命令被 Agent 拒绝
自然语言原文不进入 Shell
```

## 14. 待确认

1. 意图规划优先使用服务端 DSH，还是规则为主、DSH 兜底？
2. 首版是否允许 `diagnostics`（可能执行系统命令）还是只允许 `inspect`？
3. 指令历史是否展示给 Agent 所属应用系统所有成员，还是仅操作者/管理员？
4. 批量下发是否需要审批？
