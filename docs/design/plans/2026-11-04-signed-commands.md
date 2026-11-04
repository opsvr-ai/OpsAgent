# 签名 Agent 命令切片

## 状态

已完成并验证。

## 目标

防止 Agent 命令通道被伪造：控制面下发的每条命令都带 Ed25519 签名，Agent 执行前验证签名。

## 设计

- 控制面由 `OPSAGENT_COMMAND_SIGNING_SEED`（未配置时回退 `OPSAGENT_SECRET_KEY`）派生 Ed25519 密钥
- 命令 payload 按 key 排序生成 canonical JSON，写入 `signed_payload`
- 签名信封包含 `keyId`、`nonce`、`expiresAt`、`payload`
- Agent 校验签名、key id、过期时间和 nonce 重放
- 签名写入 `signature`
- Agent 注册响应返回 `commandPublicKey`
- Agent 将公钥持久化到 `agent-state.json`
- Agent 拉取命令后验签；失败命令上报 `invalid_signature`，不执行
- 兼容旧 Agent：未配置公钥的 Agent 继续接受命令
- 支持平滑轮换：`OPSAGENT_COMMAND_SIGNING_PREVIOUS_SEED` 保留上一把公钥，Agent 同时接受当前/上一把 key

## 数据库

```text
0033_agent_command_signatures.sql
agent_commands.signed_payload
agent_commands.signature

0034_agent_command_envelope.sql
agent_commands.nonce
agent_commands.key_id
agent_commands.expires_at
```

## 验证

- `go test ./...`：签名验证/篡改/缺签/过期测试通过
- `agent-api`：注册返回公钥与 key id，pending 命令返回 signedPayload/signature
- 容器实测：Agent 注册拿到公钥与 key id，命令 `diagnostics` 信封验签成功并完成
- 篡改 payload、过期、重复 nonce 会被拒绝

## 剩余安全项

- 密钥自动轮换与撤销
- 命令 nonce 持久化
- CSR/mTLS 与证书自动轮换
- 部署/回滚审批
