---
name: memory-usage
description: 内存、swap、缓存和内存占用进程检查
---
# 内存检查

用于“内存高不高”“为什么内存不足”等问题。

## 检查步骤

1. 调用 `inspect`，问题填写“查看内存和 swap 使用情况”。
2. 报告总内存、可用内存、使用率和 swap。
3. 不把 buffer/cache 误判为应用占用。
