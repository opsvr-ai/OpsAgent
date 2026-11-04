# Agent mTLS 传输

## 状态

已支持由外部 CA 或控制面内置 CA 签发证书，并支持 Agent 首次注册时
自动提交 CSR、控制面自动签发客户端证书。CA 轮换和吊销仍未完成。

## 控制面

环境变量：

```text
OPSAGENT_TLS_PORT=8443
OPSAGENT_TLS_CERT=/etc/opsagent/tls/server.pem
OPSAGENT_TLS_KEY=/etc/opsagent/tls/server-key.pem
OPSAGENT_TLS_CA=/etc/opsagent/tls/ca.pem
OPSAGENT_TLS_REQUIRE_CLIENT_CERT=true
```

内网可以省略证书文件，由控制面内置 CA 自动签发服务端证书：

```text
OPSAGENT_TLS_AUTO=true
OPSAGENT_TLS_DIR=.opsagent-ca
OPSAGENT_TLS_HOSTNAMES=localhost,opsagent-control
OPSAGENT_TLS_IPS=127.0.0.1
```

生成：

```text
server.pem
server-key.pem
ca.pem
```

服务端证书有效期 90 天，包含配置的 DNS/IP SAN。

证书到期前 7 天重新签发；控制面每 6 小时检查，并通过
`tlsServer.setSecureContext` 热更新，不需要重启或断开现有连接。

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

内网部署可以不提供上述文件，控制面会自动生成并持久化内部 CA：

```text
OPSAGENT_AGENT_CA_DIR=.opsagent-ca
OPSAGENT_AGENT_CA_AUTO=true
```

生成文件：

```text
.opsagent-ca/ca.pem
.opsagent-ca/ca-key.pem
```

私钥权限为 0600，目录已加入 `.gitignore`。该 CA 仅用于内网 Agent
客户端证书，不用于公网信任。

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

Agent 启动时检查证书：

```text
剩余有效期 < 7 天
  → 重新生成私钥和 CSR
  → 重新签发并覆盖
```

Agent 运行中每 6 小时检查一次：

```text
剩余 < 7 天
  → 自动续期
  → 下一次 HTTP 请求重新加载证书文件
```

证书文件由 `newHTTPClient` 每次请求重新读取，因此替换文件即可热加载，
无需重启进程。

### 到期告警

Agent 心跳上报：

```text
tlsCertExpiresAt
tlsCertSerial
```

控制面 `AgentCertificateMonitor` 每小时检查：

```text
剩余 < 30 天 → warning
剩余 < 7 天  → critical
已过期       → critical
```

写入 `agent_events`：

```text
fingerprint = certificate.expiring
```

续期并上报新证书后自动 resolve。

### 控制面证书状态

平台管理员页面展示控制面 TLS：

```text
到期时间
剩余天数
证书序列号
签发方式（内置 CA / 外部证书）
```

接口：

```text
GET /api/platform/tls
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

### 内网真机验证

Compose 已启用：

```text
8443 → 8443
OPSAGENT_TLS_AUTO=true
```

验证流程：

```text
控制面自动生成 CA 与服务端证书
  → Agent 端 CSR 请求 /api/agents/:id/certificate
  → 控制面签发 ClientAuth 证书
  → Node HTTPS 客户端使用该证书
  → GET https://127.0.0.1:8443/healthz
  → 200 {"status":"ok","service":"opsagent-control"}
```

### 吊销

平台管理员可以吊销 Agent 当前客户端证书：

```text
POST /api/platform/agents/:id/certificate/revoke
```

行为：

```text
写入 certificate_revoked_at / reason
  → 吊销序列号进入内存缓存
  → HTTPS 请求检查客户端证书序列号
  → 已吊销证书返回 403
  → 证书签发接口拒绝继续签发
```

缓存每 60 秒刷新。

### 标准 CRL

控制面从吊销序列号生成 X.509 CRL：

```text
.opsagent-ca/crl.pem
```

- 使用同一内置 CA 签名
- 有效期 7 天
- 每 60 秒重新生成
- 通过 `tlsServer.setSecureContext({ crl })` 热更新
- Node TLS 在客户端证书校验时使用 CRL

公开分发：

```text
GET /api/pki/crl
Content-Type: application/pkix-crl
```

签发的客户端证书包含 CRL Distribution Points 扩展：

```text
OPSAGENT_CRL_URL=http://control.example:8080/api/pki/crl
```

语义化 403 检查作为第二层兜底。

## 未完成

- CA 轮换、密钥托管
- OCSP
- 部署脚本自动分发 CA
- 服务端证书到期事件接入消息中心
- 到期事件接入工单/通知路由
