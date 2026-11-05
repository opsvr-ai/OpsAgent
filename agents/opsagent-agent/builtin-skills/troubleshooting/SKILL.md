---
name: troubleshooting
description: 采集失败服务、内核错误、OOM、磁盘和日志异常进行排障
---
# 故障排障

采集：

- `systemctl --failed`
- dmesg 中的 error/fail/OOM/panic
- journal 内核日志
- 磁盘空间和 inode
- 最近系统/应用日志错误

输出根因假设、证据和下一步操作，避免直接输出整段原始日志。
