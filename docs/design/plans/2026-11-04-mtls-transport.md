# Agent mTLS 传输

## 状态

已支持由外部 CA 签发的证书进行控制面 → Agent 的双向 TLS，并支持
Agent 首次注册时自动提交 CSR、控制面自动签发客户端证书。
CA 的生成、持久化、轮换和吊销仍未完成。

## 控制面

环境变量：

```text
OPSAGENT_TLS_PORT=8443
OPSAGENT_TLS_CERT=/etc/opsagent/tls/server.pem
OPSAGENT_TLS_KEY=/etc/opsagent/tls/server-key.pem
OPSAGENT_TLS_CA=/etc/opsagent/tls/ca.pem
OPSAGENT_TLS_REQUIRE_CLIENT_CERT=true
```

行为：

- 原有 HTTP 8080 仍服务 Web/内部调用
- 额外监听 HTTPS 8443
- `requestCert=true`
- 使用 CA 校验客户端证书
- 客户端证书必须带 ClientAuth

## Agent

环境变量：

```text
OPSAGENT_CONTROL_URL=https://control.example:8443
OPSAGENT_TLS_CA=/opt/opsagent/tls/ca.pem
OPSAGENT_TLS_CERT=/opt/opsagent/tls/agent.pem
OPSAGENT_TLS_KEY=/opt/opsagent/tls/agent-key.pem
```

Agent 的所有控制面 HTTP 调用、部署结果上传和 CLI 请求都使用同一 TLS 配置。

### 自动 CSR

控制面配置 CA：

```text
OPSAGENT_AGENT_CA_CERT=/etc/opsagent/ca/ca.pem
OPSAGENT_AGENT_CA_KEY=/etc/opsagent/ca/ca-key.pem
```

Agent 配置：

```text
OPSAGENT_AUTO_CSR=true
```

首次注册后：

```text
Agent 生成 ECDSA 私钥和 CSR
  → POST /api/agents/:id/certificate
  → 控制面校验 agentKey 与 CSR 签名
  → CA 签发 ClientAuth 证书
  → 写 agent.pem / agent-key.pem / ca.pem
  → 后续请求使用 mTLS
```

引导阶段需要 Agent 能访问注册端点；生产部署可先通过受控内网完成
证书签发，再切换 `OPSAGENT_CONTROL_URL` 为 HTTPS。

## 开发验证

```bash
go run apps/control/scripts/gen-dev-certs.go
pnpm --filter @opsagent/control exec tsx scripts/tls-listen-test.ts
```

脚本生成：

```text
apps/control/.dev-certs/
  ca.pem
  server.pem / server-key.pem
  client.pem / client-key.pem
```

该目录已加入 `.gitignore`，不得提交私钥。

## 未完成

- 控制面 CA 自动生成与持久化
- 证书轮换、吊销与到期告警
- 部署脚本自动分发 CA
- 证书续期与旧证书并行
