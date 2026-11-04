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
- ConnectorExecutor v1：多连接器并行取证；ClickHouse/PostgreSQL/MySQL 支持通过连接器 `diagnosticQuery` 配置诊断 SQL
- 根因置信度收敛：按根因、主机证据、连接器证据、日志信号、连接器失败动态计算 40–98% 置信度并写入时间线
- Commander 定时调度：服务启动后自动认领未排障的 open Incident，执行主机检查、连接器取证、根因收敛；支持 `OPSAGENT_COMMANDER_INTERVAL_MS`
- 自动报告：排障完成后生成 Markdown 报告事件并推送消息中心，详情页可导出
- 拓扑聚合：自动收集应用系统全部节点、应用、指标和在线状态，写入 topology 证据并参与根因置信度
- 多假设竞争：保留主假设 supported，自动生成连接器证据缺口/离线节点/应用异常等 candidate 假设并随证据重建
- 假设自动裁决：连接器成功返回证据时自动 rejected 数据缺失假设；节点全部在线时自动 rejected 节点不可用假设
- 拓扑面板：事件详情直接展示应用系统节点、应用实例和在线状态，不再只看原始 JSON 证据
- Commander 智能体分析：事件详情可调用 DshRuntime 读取证据并输出根因判断、证据缺口、下一步检查与处置建议；结果写入 ai_analysis 证据
- 可配置报告模板：租户级 Markdown 模板，支持 title/id/severity/status/source/rootCause/evidence/hypotheses/tickets/timeline 占位符
- R2/R3 审批闭环：事件详情可申请操作审批，审批/拒绝写入时间线与审计
- 专用 Source 适配器：`/internal/incident-sources/alertmanager` 与 `/internal/incident-sources/zabbix`，支持告警标准化与幂等

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
