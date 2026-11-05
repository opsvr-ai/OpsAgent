---
name: application-discovery
description: 发现系统服务、应用进程、安装路径、配置文件和日志位置
---
# 应用发现

自动扫描：

- systemd 服务、unit 文件、ExecStart、WorkingDirectory、User/Group
- 进程列表与可执行文件路径
- 应用与系统进程分类
- 配置目录、日志文件候选路径
- Docker 容器和端口

输出按“服务/进程/路径/配置/日志”分组，不输出无关系统信息。
