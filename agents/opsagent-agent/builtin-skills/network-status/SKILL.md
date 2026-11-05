---
name: network-status
description: 网卡、IPv4/IPv6、默认路由、DNS 和监听端口检查
---
# 网络检查

用于“IP 是多少”“网络通不通”“DNS 配置”等问题。

## 检查步骤

1. 调用 `inspect`，问题填写“查看网卡、IP、路由和 DNS”。
2. IP 问题只回答非 loopback 地址。
3. 端口问题再检查 `ss -lntup`。
