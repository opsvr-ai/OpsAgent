# 签名发布与部署审批切片

## 状态

已完成治理与状态机骨架；实际 Agent 部署执行尚未接入。

## 能力

### 发布签名

```text
POST /api/releases
```

请求包含：

```text
version
artifactUrl
sha256
appSystemId?
signature
```

控制面按 canonical JSON 校验 Ed25519 签名，签名无效返回：

```text
invalid_release_signature
```

公钥来源：

```text
OPSAGENT_RELEASE_PUBLIC_KEY
```

未配置时开发环境回退命令签名公钥。

### 部署计划

```text
POST /api/deployments
```

支持：

- environment
- strategy: rolling / canary
- canaryPercent

初始状态：

```text
pending
```

### 审批

```text
POST /api/deployments/:id/decision
  decision: approve | reject
```

状态：

```text
approved / rejected
```

### 回滚

```text
POST /api/deployments/:id/rollback
```

允许从：

```text
approved / canary / deploying
```

进入：

```text
rolled_back
```

### 查询

```text
GET /api/releases
GET /api/deployments
```

## 审计

```text
release.create
deployment.create
deployment.approve
deployment.reject
deployment.rollback
```

## 验证

- 签名正确发布创建成功
- 签名错误返回 400
- canary 部署创建
- 审批通过
- 回滚状态正确
- 审计记录

## 剩余

- 从审批到 Agent 执行部署
- 流量/实例级灰度推进
- 健康检查与自动回滚触发
- 制品仓库和签名证书托管
