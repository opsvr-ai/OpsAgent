# 故障定界分析模块设计稿

状态：设计评审中，未进入开发  
日期：2026-11-05  
定位：与「智能体会话」同级的独立一级模块  
目标：从操作系统智能体上报的异常和指标出发，按应用系统完成**故障发现 → 边界定界 → 证据补采 → 根因收敛**。

---

## 1. 为什么当前实现不符合需求

当前原型的问题是：

1. **按单条事件触发分析**
   - 同一应用系统多条异常会重复生成多个分析。
   - 没有按应用系统、时间窗口和关联关系聚合。

2. **只有“分析”没有“定界”**
   - 直接让模型根据异常和指标猜根因。
   - 没有计算故障边界：影响了哪些节点、应用、端口和调用关系。

3. **没有真正使用拓扑**
   - 只列主机节点。
   - 没有使用端口、连接、应用调用关系计算上下游影响范围。

4. **自动补采是模型自由发挥**
   - 模型返回 `followUp`，平台只做字符串检查。
   - 没有受控的探测类型、目标校验、优先级、预算和失败重试。

5. **缺少指标时间序列**
   - 当前只有最近心跳指标。
   - 无法判断异常是突发、持续、恢复还是周期性问题。

6. **根因缺少证据约束**
   - 模型没有必须引用证据 ID。
   - 无法区分“推测”和“已证实”。

结论：当前模块应视为原型，不继续在该结构上叠加功能，按本设计重新落地。

---

## 2. 设计原则

1. **先定界，再定因**
   - 定界：哪些对象受影响，范围多大。
   - 定因：根因在哪个对象，证据是什么。

2. **平台负责事实和边界，模型负责推理和表达**
   - 拓扑、指标、事件、连接、资产由平台采集和计算。
   - 模型只基于结构化证据做假设和总结。
   - 模型不能直接执行命令。

3. **确定性优先**
   - 关联、边界扩散、根因候选评分先用规则。
   - 模型不可用时仍能输出基础定界结论。

4. **所有自动补采可审计、可限制**
   - 受控探测类型。
   - 目标必须属于当前应用系统。
   - 单次分析有步数、并发、超时和失败预算。

5. **结论必须可追溯**
   - 每个根因假设关联证据。
   - 最终结论引用证据 ID，未引用证据的断言不进入结论。

---

## 3. 总体架构

```text
Agent 异常 / 指标 / 资产 / 连接
              │
              ▼
      信号归一化与去重
              │
              ▼
  按应用系统 + 时间窗口聚合为 Fault Case
              │
              ▼
  拓扑图构建：节点 / 应用 / 端口 / 连接边
              │
              ▼
  异常节点识别 + 边界扩散 + 根因候选评分
              │
              ├── 证据足够 ──────► 总调度智能体总结
              │
              └── 证据不足 ──────► 自动补采计划
                                      │
                                      ▼
                            平台签名 inspect 命令
                                      │
                                      ▼
                                Agent 执行返回
                                      │
                                      └── 回到候选评分
```

---

## 4. 领域模型

### 4.1 FaultCase

一次故障定界案例。

```text
id
tenant_id
app_system_id / app_system_name
title
status           open / investigating / concluded / closed
severity         critical / warning / info
fingerprint      应用系统 + 时间窗 + 主异常指纹
first_signal_at
last_signal_at
affected_nodes
affected_apps
affected_ports
root_cause
confidence
created_at
concluded_at
```

一个应用系统 + 时间窗口内同类异常，只生成一个 Case。

### 4.2 FaultSignal

归一化后的异常信号。

```text
id
case_id
tenant_id
source           agent_event / metric / inventory / connection
agent_id
hostname
app_system_id
signal_type      process / port / service / cpu / memory / disk / load / log / network
fingerprint
entity           例如 java / 3306 / order-service
severity
value
threshold
first_seen_at
last_seen_at
payload
```

### 4.3 MetricSample

指标时间序列，支持趋势和基线。

```text
id
tenant_id
agent_id
captured_at
cpu_pct
mem_load_pct
disk_free_pct
load1
process_count
custom_metrics jsonb
```

保留策略：原始 30 秒采样 7 天，1 分钟聚合 30 天。

### 4.4 TopologySnapshot

一次定界使用的拓扑快照。

```text
id
case_id
nodes           主机、应用、端口
edges           源应用:端口 → 目标应用:端口
captured_at
```

节点：

```text
node_id
kind             host / application / port
hostname
app_name
port
status
important
```

边：

```text
from_node
to_node
protocol
connection_count
last_seen_at
```

### 4.5 FaultHypothesis

候选根因。

```text
id
case_id
statement
score
status           candidate / supported / rejected
evidence_ids
missing_evidence
created_at
```

### 4.6 FaultEvidence

证据。

```text
id
case_id
kind             metric / event / topology / log / process / port / config
source
entity
summary
payload
collected_at
confidence
```

### 4.7 InvestigationTask

自动补采任务。

```text
id
case_id
agent_id
probe_type       log_tail / process_tree / port_status / service_status / network_conn / disk_usage / config
target          进程名 / 端口 / 服务名 / 时间范围
reason
priority
status
command_id
result_summary
started_at / completed_at
```

---

## 5. 触发与聚合

### 5.1 触发来源

- Agent 异常事件上报
- 重要对象缺失
- 指标越过阈值
- 连接拓扑变化
- 应用系统健康检查异常

### 5.2 聚合规则

```text
tenant_id + app_system_id + 10 分钟窗口 + 主 fingerprint
```

规则：

- 同一应用系统 10 分钟内的同类信号进入同一 Case。
- 不同指纹但存在拓扑上下游关系的信号，合并到同一 Case，标记为关联信号。
- Case 在最后一次信号后 10 分钟无新增，进入待结论。
- 已关闭 Case 后再次出现信号，新建 Case，并关联历史 Case。

### 5.3 去重

- `agent_event.fingerprint` 相同不重复建 Case。
- 同一 Case 同一实体只保留最新证据。
- 补采任务按 `probe_type + target` 去重。

---

## 6. 故障定界算法

### 6.1 构建拓扑

节点：

```text
应用系统
  ├── 主机节点
  │     ├── 应用节点
  │     └── 端口节点
```

边来自 `agent_connections`：

```text
源主机/应用:端口 → 目标主机/应用:端口
```

只保留属于当前应用系统的节点；外部依赖作为边界外节点显示，不扩散。

### 6.2 识别异常节点

输入：

- open 异常事件
- 指标偏离基线
- 重要进程缺失
- 重要端口未监听
- 重要服务 inactive
- 连接中断/异常增长

输出：

```text
anomalous_nodes
anomaly_start_time
severity
```

### 6.3 计算故障边界

以异常节点为起点：

1. 沿连接边向下游扩散 1–2 跳。
2. 包含同一应用系统内直接受影响节点。
3. 标记：
   - 根因候选区
   - 受影响区
   - 边界外依赖
4. 输出：

```text
affected_nodes
affected_apps
affected_ports
affected_edges
external_dependencies
```

### 6.4 根因候选评分

候选来源：

- 最早异常节点
- 上游连接汇聚节点
- 重要对象
- 指标突变节点
- 日志错误节点

评分：

```text
score =
  0.30 时间优先性
+ 0.25 拓扑上游性
+ 0.20 异常严重度
+ 0.15 重要资产权重
+ 0.10 重复/持续性
- 0.10 下游扩散惩罚
```

输出 Top 3 候选，而不是直接给一个结论。

### 6.5 无模型时的结论

规则引擎可以输出：

```text
最可能根因：节点 X 的 Java 进程异常
影响范围：3 个节点、2 个应用、1 个数据库端口
置信度：0.55
建议：补采该节点线程栈和日志
```

---

## 7. 自动补采

### 7.1 补采计划

平台根据证据缺口生成：

```json
{
  "probeType": "process_tree",
  "hostname": "zdh-sit1-app-01",
  "target": "java",
  "reason": "Java 进程异常但缺少线程和启动参数",
  "priority": 1
}
```

### 7.2 受控探测类型

```text
log_tail
process_tree
port_status
service_status
network_conn
disk_usage
config_snapshot
```

不允许模型输出任意 shell。

### 7.3 执行约束

- 目标必须属于当前 Case 的应用系统。
- 单 Case 最多 6 个补采任务。
- 并发最多 3 个。
- 单任务超时 30 秒。
- 同一任务失败 1 次后不再重试。
- 补采结果写入 `FaultEvidence`。

### 7.4 补采后重新评分

补采返回后：

1. 更新证据。
2. 重新计算候选评分。
3. 如果 Top 候选差距小于阈值，继续补采，最多 2 轮。
4. 否则进入总调度结论。

---

## 8. 总调度智能体

### 8.1 输入

```text
Case 概要
拓扑快照
异常节点和边界
Top 3 根因候选
结构化证据列表
补采结果
```

### 8.2 输出

```json
{
  "rootCause": "order-service 连接池耗尽",
  "rootCauseNode": "zdh-sit1-app-01",
  "confidence": 0.82,
  "affectedSummary": "订单中心 2 个节点受影响，数据库连接异常",
  "evidenceIds": ["evt-1", "metric-2", "log-3"],
  "recommendations": ["检查连接池配置", "扩容数据库连接数"],
  "needsHumanConfirmation": true
}
```

### 8.3 约束

- 只能引用已有证据 ID。
- 未引用证据的断言不能进入最终结论。
- 置信度低于 0.65 时标记“待人工确认”。
- 模型不可用时使用规则引擎结论。
- 结论写入 Case，并可一键转为 Incident。

---

## 9. 页面设计

### 9.1 故障定界列表

```text
[应用系统] [时间范围] [状态] [严重度] [自动分析]

订单中心       critical   3 节点 / 2 应用    分析中
支付网关       warning    1 节点 / 1 应用    已结论
基础平台       info       0 节点             已关闭
```

字段：

- 应用系统
- 状态
- 影响节点/应用/端口数
- 根因摘要
- 置信度
- 最近信号时间

### 9.2 Case 详情

```text
标题：订单中心故障定界
状态：分析中 · 置信度 0.72
影响：2 节点 / 3 应用 / 2 端口

[拓扑定界] [证据链] [根因候选] [补采任务] [结论]
```

#### 拓扑定界

- 节点按状态着色
- 根因候选区红色
- 受影响区橙色
- 边界外灰色
- 连接边显示 `应用:端口 → 应用:端口`
- 点击节点查看指标、事件、资产

#### 证据链

按时间排序：

```text
10:01:02  Agent 上报 Java 进程异常
10:01:05  指标 CPU 95%
10:01:20  自动补采日志
10:01:35  发现连接池超时
10:02:00  根因候选更新
```

#### 根因候选

```text
1. Java 连接池耗尽        score 0.72
   证据：事件 2 条、日志 1 条、指标 3 个
2. 数据库连接拒绝         score 0.51
3. 节点资源不足           score 0.30
```

#### 补采任务

```text
进程树        zdh-sit1-app-01   java        completed
日志 tail     zdh-sit1-app-01   app.log     completed
端口状态      zdh-sit1-db-01    3306        running
```

#### 结论

- 根因
- 影响范围
- 证据引用
- 处置建议
- 一键创建 Incident
- 人工确认/驳回

---

## 10. 与已有功能的增强

| 已有功能 | 增强 |
| --- | --- |
| Agent 事件 | 增加 signal_type、entity、fingerprint、时间序列字段 |
| Agent 指标 | 增加 MetricSample 时间序列表，保留 30 秒采样 |
| Agent 连接 | 作为拓扑边来源，补充连接数、状态 |
| 巡检对象 | 重要对象作为根因权重和补采触发条件 |
| 事件指挥 | 不再承担根因分析，只消费故障定界结论创建 Incident |
| 智能体控制 | 提供受控 probe 类型，不接受自由文本命令 |
| 模型配置 | 默认模型用于根因推理，必须有规则降级 |
| 应用系统 | 增加依赖关系/外部依赖标记 |

---

## 11. 接口草案

```text
GET  /api/fault-cases
GET  /api/fault-cases/:id
POST /api/fault-cases/:id/reanalyze
POST /api/fault-cases/:id/close
POST /api/fault-cases/:id/confirm-root-cause
POST /api/fault-cases/:id/investigate
GET  /api/fault-cases/:id/evidence
GET  /api/fault-cases/:id/topology
```

---

## 12. 分阶段落地

### Phase 1：可用的定界底座

- FaultCase 聚合模型
- MetricSample 时间序列
- 拓扑节点/边快照
- 异常节点识别
- 故障边界计算
- 列表和详情页（定界图 + 证据链）
- 规则引擎兜底

### Phase 2：自动补采

- InvestigationTask 模型
- 受控 probe 类型
- Agent 命令下发、等待、合并
- 两轮补采和预算控制
- 补采任务页面

### Phase 3：根因智能收敛

- 候选评分
- 总调度模型 JSON 输出
- 证据引用校验
- 人工确认
- Incident 联动与历史案例

---

## 13. 验收标准

1. 同应用系统 10 分钟内 5 条同类异常，只生成 1 个 Case。
2. Java 进程被 kill：
   - 15 秒内产生信号
   - 生成 Case
   - 定界包含该主机和应用
   - 自动补采日志/进程
   - 输出根因候选和置信度。
3. 数据库端口异常：
   - 拓扑显示调用方 → 数据库端口边
   - 影响范围包含调用方应用。
4. 模型不可用：
   - 规则引擎仍输出边界和根因候选。
5. 模型返回无证据引用：
   - 结论被拒绝，回退候选列表。
6. 补采超过 6 个任务：
   - 停止新增，标记“证据不足”。
7. 事件指挥只展示已定界结论或人工创建的 Incident，不展示原始异常列表。

---

## 14. 需要确认

1. 故障定界是否只限单个应用系统内部，还是需要跨应用系统依赖定界？
2. 10 分钟聚合窗口是否合适？
3. 自动补采是否允许超过 6 个任务，还是固定预算？
4. 模型置信度低于 0.65 是否必须人工确认？
5. 事件指挥是否只消费故障定界结论，不再直接展示 Agent 原始告警？
6. Phase 1 是否先不做模型根因，只做聚合、拓扑定界、证据链和规则结论？

确认后再开始开发。
