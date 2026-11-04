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

### 制品预检

```text
POST /api/deployments/:id/preflight
```

控制面拉取制品并校验：

```text
HTTP 状态可访问
尺寸 ≤ 100 MB
SHA-256 与 Release 清单一致
```

通过：

```text
status = preflighted
preflight = { ok, expected, actual, bytes, checkedAt }
```

失败：

```text
status = preflight_failed
preflight = { ok: false, error, checkedAt }
```

### 实际执行

签名 Manifest 中可携带：

```text
deployCommand
rollbackCommand
```

```text
POST /api/deployments/:id/execute
```

控制面：

```text
选择应用系统在线 Agent
  → 下发 deployment_execute 命令
  → 等待命令完成
  → 全部成功：deployed
  → 任一失败：failed
```

Agent：

```text
下载制品
  → 校验 SHA-256
  → 注入 OPSAGENT_ARTIFACT / OPSAGENT_VERSION
  → 执行 deployCommand
  → 回传输出与校验结果
```

回滚在执行后使用同一命令通道发送 `rollbackCommand`：

```text
deployed → rolling_back → rolled_back / rollback_failed
```

部署失败会自动创建 Incident：

```text
source = deployment
sourceRef = deployment:<id>
severity = P1
rootCause = 部署执行失败/自动回滚失败
evidence = 命令 ID、结果、失败原因
```

失败和回滚失败都进入 Commander 事件队列，便于继续排障。

### 健康门禁与自动回滚

执行前检查应用系统是否存在 open Agent 异常事件，存在则拒绝部署。

### canary 分批

canary 部署按比例选择 Agent：

```text
ceil(在线 Agent 数 × canaryPercent / 100)
```

首批成功：

```text
status = canary
```

推进全量：

```text
POST /api/deployments/:id/promote
  → 对剩余 Agent 下发 deployCommand
  → 全部成功：deployed
  → 失败：failed + Incident
```

canary 阶段出现新 Agent 异常时，健康监控会只回滚已灰度节点。

部署成功后（含 canary 阶段）：

```text
DeploymentMonitor 每 30 秒检查
  → 新出现的 open Agent 事件
  → 自动执行 signed rollbackCommand
  → canary 只回滚已灰度节点
  → 状态 rolling_back → rolled_back / rollback_failed
  → 消息中心通知
```

### 查询

```text
GET /api/releases
GET /api/deployments
```

### Web 页面

“发布与部署”页面支持：

- 查看发布记录
- 粘贴签名创建 Release
- 创建 rolling / canary 部署计划
- 批准 / 拒绝
- 制品预检
- 手动回滚


## 审计

```text
release.create
deployment.create
deployment.approve
deployment.reject
deployment.rollback
deployment.preflight
deployment.execute
```

## 验证

- 签名正确发布创建成功
- 签名错误返回 400
- canary 部署创建
- 审批通过
- 回滚状态正确
- 审计记录

### 真机实测

在 `opsagent-os-agent` 上完成：

```text
签名 Release 9.9.9-live2
  → staging 部署
  → 审批
  → 制品预检通过
  → execute 200
  → 状态 deployed
  → Agent /tmp/opsagent-deploy-test 内容正确
  → rollback 200
  → 状态 rolled_back
  → /tmp/opsagent-deploy-test 已删除
```

同时修正种子 Agent 的未来 `last_seen`，避免部署选择不会拉取命令的演示 Agent。

## 剩余

- 流量/实例级灰度推进
- 制品仓库和签名证书托管
- Windows 部署执行器
