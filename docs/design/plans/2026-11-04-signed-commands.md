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
- 心跳刷新：控制面在心跳响应返回当前 key 集合，Agent 自动更新并落盘；撤销上一把 key 后无需重新注册
- 结果签名：Agent 注册时生成结果签名密钥，命令结果回传带 `resultSigned`/`resultSignature`，控制面验签后才入库
- 结果密钥复用：Agent 重启从 `agent-state.json` 加载结果私钥，不重复轮换；实测两次重启公钥一致
- 结果私钥加密：配置 `OPSAGENT_STATE_SECRET` 后使用 AES-256-GCM 加密落盘，测试覆盖解密/错密钥拒绝

## 数据库

```text
0033_agent_command_signatures.sql
agent_commands.signed_payload
agent_commands.signature

0034_agent_command_envelope.sql
agent_commands.nonce
agent_commands.key_id
agent_commands.expires_at

0035_agent_result_signing.sql
agents.result_public_key
```

## 验证

- `go test ./...`：签名验证/篡改/缺签/过期测试通过
- `agent-api`：注册返回公钥与 key id，pending 命令返回 signedPayload/signature
- 容器实测：Agent 注册拿到公钥与 key id，命令 `diagnostics` 信封验签成功并完成
- 结果实测：Agent 回传结果签名，控制面验签通过后入库
- 篡改 payload、过期、重复 nonce 会被拒绝

## 剩余安全项

- 密钥自动轮换与撤销
- 命令 nonce 持久化
- CSR/mTLS 与证书自动轮换
- 部署/回滚审批
