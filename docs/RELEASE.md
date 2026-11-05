# OpsAgent 0.3.2 发布说明

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
- 主机级 canary 分批
- 流量级 canary 权重与 Nginx 配置生成
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
  → 标准 OCSP 响应 + AIA
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
1. docker compose build control   # 镜像内 Go 阶段自动编译三个 Agent 二进制
2. docker compose up -d
3. seed 数据库
4. 登录控制面
5. 控制面自动生成内网 CA 与服务端证书
6. Agent 配置 OPSAGENT_AUTO_CSR=true 并注册
7. 构建 Desktop 更新源
8. 配置 OPSAGENT_DESKTOP_UPDATE_URL
```

控制面镜像内的 Agent 分发包路径：

```text
/opt/opsagent-agent-dist/opsagent-agent-linux-amd64
/opt/opsagent-agent-dist/opsagent-agent-linux-arm64
/opt/opsagent-agent-dist/opsagent-agent-windows-amd64.exe
```

无需在宿主机安装 Go，也无需手工执行 `pnpm agent:dist`。
只有非容器开发才需要手工构建。

## 验证基线

```text
pnpm test    226 passed | 3 skipped
pnpm e2e     14 passed
go test ./... 通过
pnpm build   通过
控制面       healthy
8443         mTLS
CRL          HTTP 200
OCSP         HTTP 200
真机部署/回滚 通过
```

## 已知限制

- 没有公网信任链，证书仅适用于内网
- CA 轮换需人工编排
- OCSP 已实现，生产需配置可访问的 AIA 域名
- 流量级 canary 控制面完成，数据面需入口代理应用生成的 Nginx 配置
- Windows Job Object 限额已实现，需 Windows 执行主机实机压测
- G0–G10 工程验收通过，外部环境与正式签字待完成

详见：

- `docs/design/plans/2026-11-04-acceptance-status.md`
- `docs/design/plans/2026-11-04-mtls-transport.md`
- `docs/design/plans/2026-11-04-release-deployment.md`
