# OpsAgent 0.3.2 最终交付说明

日期：2026-11-05

## 1. 交付结论

平台侧代码、自动化测试、内网 PKI OCSP、流量级灰度控制面和正式验收
材料已交付。需要外部证书、生产入口代理、十台混合主机和人工签字的项
已列入第 6 节，不属于代码缺口。

## 2. 本次新增

### OCSP

```text
POST /api/pki/ocsp
GET  /api/pki/ocsp/:base64url-request
```

- 标准 DER OCSP 响应
- SHA-1 / SHA-256 CertID
- issuer name hash / key hash 校验
- good / revoked / unknown
- CA 私钥签名，携带 CA 证书
- 证书 AIA OCSP 扩展
- CRL 继续保留

### 流量级 canary

```text
POST /api/deployments/:id/traffic-canary
POST /api/deployments/:id/traffic-canary/weight
GET  /api/deployments/:id/traffic-canary
GET  /api/deployments/:id/traffic-canary/nginx
```

- 稳定上游 / 灰度上游
- 0–100% 权重
- 0% 回滚 / 100% 转正
- Nginx `split_clients` 配置生成
- Web 配置、权重调整、配置查看
- 审计

### 正式验收

- `docs/design/plans/2026-11-04-acceptance-status.md`
- G0–G10 工程矩阵
- 外部待签清单
- 签字表

### Windows 资源限额

```text
OPSAGENT_AGENT_MEMORY_LIMIT_MB=512
OPSAGENT_AGENT_CPU_PERCENT=50
```

- Windows 服务模式创建 Job Object
- 内存与 CPU 硬上限
- 子进程继承限制
- Linux 继续使用 systemd/cgroup

## 3. 交付物

```text
apps/control                 控制面
apps/web                     Web
packages/contracts           契约
agents/opsagent-agent        Go Host Agent
apps/desktop                 Desktop
apps/control/migrations      0059–0062
docs/RELEASE.md              发布说明
docs/FINAL-DELIVERY.md       本文件
docs/design/plans/           设计、验收、PKI、部署文档
```

## 4. 验收证据

```text
pnpm test       230 passed | 3 skipped
pnpm build      通过
pnpm e2e        14 passed
go test ./...   通过
Control         healthy
8443            mTLS
CRL             HTTP 200
OCSP            HTTP 200 application/ocsp-response
OCSP 实时响应    status=successful, serial=1234, 650 bytes
```

## 5. 升级步骤

```text
1. 备份数据库
2. 应用迁移 0059–0062
3. docker compose build control（Go 阶段自动编译三个 Agent 二进制到 /opt/opsagent-agent-dist）
4. docker compose up -d control
5. 在入口代理应用 traffic-canary 生成的 Nginx 配置
6. 配置 OPSAGENT_OCSP_URL 为客户端可达地址
7. 验证 CRL / OCSP / 8443 mTLS
8. 在 Web 部署页创建流量灰度策略
```

数据库迁移：

```text
0059_operations_alert_auto_replay.sql
0060_side_effect_auto_retry.sql
0061_approval_notification_archive.sql
0062_traffic_canary_policies.sql
```

## 6. 外部待提供 / 待签

| 项目 | 需要 |
| --- | --- |
| G0 正式兼容性矩阵 | 按目标 dsh 版本签字 |
| 十台混合 Linux 环境 | G9 集群安装/采集/限额 |
| Windows 主机 | Windows Job Object 限额实机压测 |
| 企业代码签名证书 | Desktop 安装包受信 |
| 生产入口代理 | 应用流量 canary Nginx 配置 |
| 生产 OCSP 域名 | AIA 可达、防火墙放行 |
| 安全/运维/产品签字 | 验收表 |

## 7. 安全边界

- 不开放任意 Shell
- 不开放未审批写操作
- 删除文件、修改系统配置、安装软件不在范围
- OCSP 只返回证书状态，不返回私钥或租户数据
- 流量灰度配置仅生成，需入口代理显式应用
- 所有写操作审计

## 8. 最终判定

```text
代码交付：完成
自动化验收：通过
OCSP：完成并通过实时验证
流量级 canary 控制面：完成
流量数据面：待入口代理应用
G0–G10：工程侧通过，正式签字待外部
```
