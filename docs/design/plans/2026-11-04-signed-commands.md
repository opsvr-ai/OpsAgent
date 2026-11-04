# 签名 Agent 命令切片

## 状态

已完成并验证。

## 目标

防止 Agent 命令通道被伪造：控制面下发的每条命令都带 Ed25519 签名，Agent 执行前验证签名。

## 设计

- 控制面由 `OPSAGENT_COMMAND_SIGNING_SEED`（未配置时回退 `OPSAGENT_SECRET_KEY`）派生 Ed25519 密钥
- 命令 payload 按 key 排序生成 canonical JSON，写入 `signed_payload`
- 签名写入 `signature`
- Agent 注册响应返回 `commandPublicKey`
- Agent 将公钥持久化到 `agent-state.json`
- Agent 拉取命令后验签；失败命令上报 `invalid_signature`，不执行
- 兼容旧 Agent：未配置公钥的 Agent 继续接受命令

## 数据库

```text
0033_agent_command_signatures.sql
agent_commands.signed_payload
agent_commands.signature
```

## 验证

- `go test ./...`：签名验证/篡改/缺签测试通过
- `agent-api`：注册返回公钥，pending 命令返回 signedPayload/signature
- 容器实测：Agent 注册拿到公钥，命令 `diagnostics` 验签成功并完成
- 篡改 payload 或签名会被拒绝

## 剩余安全项

- 密钥轮换与 key id
- 命令 nonce/过期时间
- CSR/mTLS 与证书自动轮换
- 部署/回滚审批
