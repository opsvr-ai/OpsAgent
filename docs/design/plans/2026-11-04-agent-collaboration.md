# 多 Agent 异常分析与协同排查

## 目标

```text
Agent 发现异常
  → 自动上报平台
  → 平台聚合应用系统内所有 Agent 信息
  → 自动定位根因
  → Commander 下发进一步排查指令
```

## 1. Agent 侧自动发现与上报

Agent 定时巡检并产生事件：

```text
磁盘空间不足
内存使用率过高
服务/进程异常
端口/应用状态异常
日志异常关键字
```

通过：

```text
POST /api/agents/:id/events
```

上报，支持：

```text
fingerprint
severity
title
detail
metric
details.applicationLogs / systemLogs
```

已有异常不会重复创建；恢复后自动 resolve。

## 2. 平台聚合

`AppHealthService.triggerForAgentEvent()`：

```text
定位异常 Agent 所属应用系统
  → 读取应用系统下所有 Agent
  → 汇总每个 Agent 的：
       metrics
       applications
       open events
       log signals
  → 生成节点健康 findings
```

节点状态：

```text
healthy / warning / critical / offline
```

## 3. 根因定位

`deriveRootCause()`：

```text
1. 触发节点离线 → 节点离线优先
2. 同一异常出现在 ≥ 2 个节点 → 多节点共同异常
3. 单节点有异常 → 该节点首个异常
4. 否则 → 未发现明确根因
```

同时聚合所有 Agent 的日志异常关键字。

结果写入：

```text
app_system_health_checks
messages
incidents
incident_evidence
```

## 4. Commander 多节点排查

`IncidentService.investigate()` 现在会：

```text
读取事件所属应用系统
  → 选择最多 8 个在线 Agent
  → 给每个 Agent 下发 inspect 命令
  → 等待命令完成
  → 每个节点的结果单独写入 host_inspection 证据
  → investigation_started / completed 事件
  → 继续连接器证据、拓扑证据、根因收敛和报告
```

不再只检查触发节点。

## 5. 真实验证

使用 `opsagent-os-agent` 上报模拟磁盘异常：

```text
POST /api/agents/:id/events
  → 应用系统 订单中心 自动生成 P1 Incident
  → POST /api/incidents/:id/investigate
  → 约 4.2 秒完成
  → incident_evidence = 6 条
  → investigation_completed
  → root_cause_converged
  → report_generated
```

根因示例：

```text
opsagent-os-agent：场景测试：磁盘异常：模拟磁盘使用率异常
```

验证完成后已 resolve 测试事件和 Incident。

## 6. 当前边界

- 只对在线且 90 秒内有心跳的 Agent 下发排查命令
- 单次最多 8 个 Agent
- 离线节点作为 findings 证据，不等待命令
- 真正的应用层日志/链路数据仍依赖连接器
- 多 Agent 同时返回大结果时依赖证据截断和 payload 存储
