---
name: container-status
description: Docker 容器、镜像、运行状态和日志检查
---
# 容器检查

用于“容器有没有挂”“Docker 日志”等问题。

## 检查步骤

1. 调用 `inspect`，问题填写“查看容器运行状态”。
2. 只读使用 `docker ps`、`docker inspect`、`docker logs`。
3. 不执行 `docker rm`、`docker stop`、`docker restart`。
