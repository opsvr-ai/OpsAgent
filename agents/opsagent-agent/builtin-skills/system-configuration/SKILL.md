---
name: system-configuration
description: 采集内核、CPU、内存、磁盘、网络、路由、DNS、sysctl 和 ulimit 配置
---
# 系统配置采集

覆盖：

- OS release、内核、CPU、内存、磁盘、挂载
- 网卡、IP、路由、DNS
- sysctl 关键参数、ulimit、SELinux、防火墙状态
- 时区、运行时长、虚拟化

用于配置核查和变更前基线，不输出无关业务日志。
