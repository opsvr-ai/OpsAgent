---
name: logs-recent
description: 系统日志、应用日志和最近错误检查
---
# 日志检查

用于“最近有什么报错”“查看系统日志”等问题。

## 检查步骤

1. 调用 `inspect`，问题填写“查看最近系统日志”。
2. 使用 `journalctl --no-pager -n` 或只读 `tail`。
3. 日志内容不截断；只摘出与问题相关的错误行。
