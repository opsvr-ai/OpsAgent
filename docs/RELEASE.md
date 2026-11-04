# OpsAgent 0.2.0 发布说明

## 定位

内网多租户 AIOps 平台：

```text
控制面 + Web + Commander + 9 类连接器
+ Go Host Agent + Electron Desktop
```

## 本轮可用能力

### 平台

- 租户、角色、权限、审计、主题
- 会话、场景、知识、消息、长任务
- Commander 事件、证据、假设、报告、SLA、审批
- 发布与部署控制台

### 发布

- 签名 Release
- 制品 SHA-256 预检
- canary 分批与全量推进
- 健康门禁
- 部署 / 回滚真机验证
- 部署失败自动 Incident
- 新异常自动回滚
- 可选 canary 稳定自动全量

### Agent

- 安装、发现、巡检、只读诊断
- systemd 内存 / CPU / IO / 任务数限额
- 容器资源限额
- 资源阈值事件
- 只读操作无需审批
- 部署命令由 Release 签名

### 内网 PKI

```text
内置 CA（外部 CA 可选）
  → 控制面服务端证书自动签发 / 复用 / 热续期
  → Agent CSR 自动签发 ClientAuth 证书
  → 启动 + 每 6 小时检查，7 天内续期
  → 证书到期事件
  → 吊销 + CRL + CRL 分发
  → 吊销审计
```

### Desktop

- Electron 薄客户端
- 便携 ZIP / NSIS
- 自动更新客户端
- 控制面托管更新源
- 内网自签名签名脚本

## 部署顺序

```text
1. docker compose up -d
2. seed 数据库
3. 登录控制面
4. 控制面自动生成内网 CA 与服务端证书
5. Agent 配置 OPSAGENT_AUTO_CSR=true 并注册
6. 构建 Desktop 更新源
7. 配置 OPSAGENT_DESKTOP_UPDATE_URL
```

## 验证基线

```text
pnpm test    187 passed | 3 skipped
pnpm e2e     13 passed
go test ./... 通过
pnpm build   通过
控制面       healthy
8443         mTLS
CRL          HTTP 200
真机部署/回滚 通过
```

## 已知限制

- 没有公网信任链，证书仅适用于内网
- CA 轮换需人工编排
- OCSP 未实现，当前使用 CRL
- 流量级 canary 依赖入口代理
- Windows Job Object 限额未实现
- G0–G10 尚未正式签字

详见：

- `docs/design/plans/2026-11-04-acceptance-status.md`
- `docs/design/plans/2026-11-04-mtls-transport.md`
- `docs/design/plans/2026-11-04-release-deployment.md`
