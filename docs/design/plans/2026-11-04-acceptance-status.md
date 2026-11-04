# G0–G10 正式验收包（2026-11-05）

> 结论：代码与自动化验收通过；需要外部环境、正式证书或人工签字的项目
> 已单独列为「待外部签字」，不再作为代码缺口。

## 1. 验收范围

```text
控制面（Fastify + PostgreSQL + RLS）
Web（React + Vite）
Commander / Incident / 证据 / 报告
9 类连接器
Go Host Agent
内网 PKI / mTLS / CRL / OCSP
发布 / 部署 / 主机 canary / 流量级 canary
Desktop 薄客户端
```

## 2. 自动化证据

```text
pnpm test       217 passed | 3 skipped
pnpm build      通过
pnpm e2e        13 passed
go test ./...   通过
Control         healthy
Agent           在线
8443            mTLS
CRL             HTTP 200
OCSP            HTTP 200 application/ocsp-response
```

E2E 覆盖：

```text
登录 → 工作台 → 会话 → mock 工具 → 审批 → 拒绝执行
全部侧栏页面
主题
退出
平台管理员
Agent 安装页
侧栏会话恢复
Managed Agent 清单问答
```

## 3. Gate 状态

| Gate | 验收内容 | 证据 | 状态 |
| --- | --- | --- | --- |
| G0 | dsh 兼容性、工具、审批、模型、隔离、沙箱、长任务 | 运行时/连接器/审批/沙箱/长任务自动化；兼容性矩阵见第 4 节 | 工程通过，人工签字待外部 |
| G1 | 登录、角色、会话、mock 工具、审批、审计、跨租户拒绝 | Playwright + API 测试 | 通过 |
| G2a | 4 类监控连接器、审批拒绝、凭据隔离 | 契约与审批测试 | 通过 |
| G2b | 9 类连接器、场景报告 | 契约测试 + 场景 E2E | 通过 |
| G3a | Studio 生成、沙箱安装、测试门禁 | API/单测 | 通过 |
| G4 | P1 页面、主题、成员、分享、审计 | E2E | 通过 |
| G5 | 数据沉淀、消息、知识、长任务恢复 | API/单测 | 通过 |
| G6a/G6b | 知识草稿、无人值守巡检、Desktop 登录 | API/单测 + Desktop 构建 | 通过 |
| G7 | 隔离、安全、备份恢复、发布 | 单测 + 发布手册 | 代码通过，环境演练待外部 |
| G8a/G8b/G8c | 告警 → Incident → 证据 → 假设 → 审批 → 报告 | 单测/API/UI/E2E | 通过 |
| G9 | Host Agent 安装、采集、资源限额、跨租户 | 单机真机 + 资源限额测试 | 单机通过；10 台混合环境待外部 |
| G10 | 受控部署、主机 canary、健康门禁、回滚、流量 canary | 真机部署/回滚 + API 测试 | 主机通过；流量数据面待入口应用 |

## 4. G0 七项工程检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| dsh 运行时启动与会话 | 通过 | runtime/session 测试 |
| Connector SDK 契约 | 通过 | contracts + 9 connector 测试 |
| 类型化工具注册 | 通过 | scenario/connector API |
| 审批与拒绝路径 | 通过 | approval API + E2E |
| 模型调用失败降级 | 通过 | model/runtime 测试 |
| 租户与工作区隔离 | 通过 | tenancy/RLS 测试 |
| 长任务恢复 | 通过 | long-task 测试 |

正式 dsh 兼容性矩阵仍需产品/架构负责人按目标 dsh 版本逐项签字。

## 5. PKI 验收

```text
内置 CA / 外部 CA
Agent CSR 自动签发 ClientAuth
控制面 serverAuth 自动签发 / 热续期
吊销
CRL 生成与分发
OCSP 标准 DER 响应
证书 AIA OCSP / CRL Distribution Points
新旧 CA 过渡
```

OCSP：

```text
POST /api/pki/ocsp
GET  /api/pki/ocsp/:base64url-request
Content-Type: application/ocsp-request
Response: application/ocsp-response
```

验证：

```text
证书 issuer hash 校验通过
SHA-1 CertID 通过
good / revoked / unknown
签名由 CA 私钥完成
真实响应 650 bytes，status = successful，unknown 状态正确返回
```

## 6. 流量级 canary 验收

控制面新增：

```text
traffic_canary_policies
POST /api/deployments/:id/traffic-canary
POST /api/deployments/:id/traffic-canary/weight
GET  /api/deployments/:id/traffic-canary
GET  /api/deployments/:id/traffic-canary/nginx
```

支持：

```text
稳定上游 / 灰度上游
1–100% 灰度权重
0% 回滚
100% 转正
Nginx split_clients 配置生成
Web 配置与权重操作
审计
```

数据面接入方式：

```text
1. 在部署页配置入口域名与两个上游
2. 复制生成的 Nginx 配置
3. 在入口代理 reload
4. 观察错误率/延迟
5. 逐步调整 10 → 25 → 50 → 100 或回退 0
```

入口代理本身属于环境资产，代码仓库只负责生成并审计权重配置。

## 7. 外部待签 / 待提供

| 项目 | 需要 |
| --- | --- |
| G0 正式兼容性矩阵 | 架构/产品按目标 dsh 版本签字 |
| G9 十台混合环境 | 10 台 Linux（含混合发行版）与 Windows 主机 |
| Windows Job Object 限额 | Windows 执行主机实机验证 |
| 正式代码签名证书 | 企业代码签名证书与时间戳服务 |
| OCSP 生产域名 | 生产入口域名、AIA 可达性与防火墙放行 |
| 流量数据面 | 企业入口代理/负载均衡执行生成的配置 |
| 安全与合规签字 | 安全、运维、产品负责人 |

## 8. 签字

| 角色 | 姓名 | 结论 | 日期 |
| --- | --- | --- | --- |
| 架构负责人 |  |  |  |
| 安全负责人 |  |  |  |
| 运维负责人 |  |  |  |
| 产品负责人 |  |  |  |

签字前置条件：完成第 7 节外部项，并在目标环境重跑第 2 节命令。
