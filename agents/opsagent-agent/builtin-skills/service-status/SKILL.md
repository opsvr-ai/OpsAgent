---
name: service-status
description: systemd 服务状态、启动失败和运行中的应用检查
---
# 服务检查

用于“服务正常吗”“哪个服务挂了”等问题。

## 检查步骤

1. 调用 `inspect`，问题填写“查看运行中的服务和进程”。
2. 只读检查使用 `systemctl status/show/list-units`。
3. 启动、停止、重启、启用、禁用必须走平台审批，不在只读技能中执行。
