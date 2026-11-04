# P1.6 Commander 事件域切片（2026-11-04）

> 本文件是 P1.6 的当前执行切片，不改变 `01-development-plan.md` 的 48 周范围。

## 已完成

- Agent 异常事件自动触发应用系统健康检查
- 应用系统健康检查自动生成 Incident，`source=agent_health`
- Incident 关联应用系统、触发事件和根因
- 自动写入证据：根因、日志信号
- 自动生成故障假设（含置信度）
- 自动生成处置任务（值班 SRE）
- 事件详情 UI 展示根因、证据、假设、处置任务
- 数据库：`incident_evidence`、`incident_hypotheses`、`incident_tickets`
- Commander Executor v0：事件详情「自动排障」按钮向触发主机下发 inspect 命令，收集主机证据、更新时间线/假设/任务
- Source 去重：同一应用系统未关闭的同标题 Incident 不重复创建
- Source 接入骨架：`POST /internal/incident-sources` 接收 Alertmanager/Zabbix/Webhook，按 `source + sourceRef` 幂等
- 事件报告：`GET /api/incidents/:id/report` 输出 Markdown，详情页可导出
- ConnectorExecutor v0：自动排查时按租户已配置的 Prometheus/Zabbix/Alertmanager 连接器执行只读查询，成功/失败都写入证据
- R2/R3 审批闭环：事件详情可申请操作审批，审批/拒绝写入时间线与审计

## 验收（已通过）

```text
Agent 异常 → 应用健康检查 → Incident 自动创建
Incident 详情：root_cause / evidence / hypothesis / ticket 可见
自动排障 → Agent 执行 inspect → host_inspection 证据回填 → 任务完成
pnpm test / pnpm build / pnpm e2e 通过
```

## 下一批任务

1. Commander 执行器
   - 从 Incident 自动派发 Connector 查询（Prometheus/Zabbix/ClickHouse/DB）
   - 证据回填与超时审计
2. 审批闭环
   - R2/R3 动作生成审批单
   - 审批后继续取证/处置
3. Source 去重与分组
   - 相同应用系统/故障指纹聚合，避免告警风暴
4. 事件报告
   - 根因、证据、假设、任务、时间线导出
5. 与 dsh-superagent 的关系
   - 当前是 OpsAgent 原生事件域 + 自动根因切片，尚未 fork Commander 智能体
   - 后续按计划引入 Commander 总调度，不把现有事件域回退
