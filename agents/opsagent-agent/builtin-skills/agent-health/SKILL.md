---
name: agent-health
description: OpsAgent 安装路径、版本、配置、日志和自检
---
# Agent 健康检查

用于“Agent 装在哪”“Agent 版本”“Agent 是否正常”等问题。

## 检查步骤

1. 调用 `inspect`，问题填写“查看 Agent 部署路径和运行状态”。
2. 报告版本、根目录、配置、日志、快照和工作区路径。
3. 需要完整目录时使用 `tree`/`ls` 只读查看 `/opt/opsagent`。
