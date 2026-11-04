# G0–G10 验收现状（2026-11-04）

> 本文记录代码与自动化证据，不代表正式签字。P2-A 的 CSR/mTLS、Desktop
> 正式代码签名证书仍需要外部证书或 CA 基础设施，G0 的 dsh 兼容性矩阵
> 仍需人工逐项确认。

## 已完成并有证据

| Gate | 当前证据 | 状态 |
| --- | --- | --- |
| G1 | Playwright：登录 → 工作台 → 会话 → mock 工具 → 审批 → 审计 | 自动化通过 |
| G2a/G2b | 9 类连接器契约、审批拒绝、只读探针 | 单测通过 |
| G3a | Studio 生成与沙箱安装链路 | 单测/API 通过 |
| G4 | P1 页面、主题、成员、分享、审计 | E2E 通过 |
| G5–G7 | Commander 事件、证据、假设、报告、SLA、审批 | 单测/API 通过 |
| G8 | 无 shell 工具、审批拒绝、审计脱敏 | 单测通过 |
| G9 | systemd 内存/CPU/IO、容器资源、资源阈值事件 | 单测通过；真机安装脚本待签 |
| G10 | 真机签名部署：审批 → 预检 → execute → deployed → rollback → 文件删除 | 已实测 |

## 关键验证数字

```text
pnpm test    179 passed | 3 skipped
pnpm e2e     13 passed
go test ./... 通过
pnpm build   通过
```

## 未完成，需要外部条件

| 项目 | 阻塞 |
| --- | --- |
| CSR/mTLS Agent 证书自动签发 | 需要 CA、证书生命周期和轮换设计 |
| Desktop 正式代码签名 | 需要生产代码签名证书 |
| 控制面 HTTPS/mTLS | 已支持外部证书双向 TLS；自动签发/轮换未完成 |
| 流量级 canary | 需要入口代理/负载均衡流量权重控制 |
| G0 完整签字 | 需要 dsh 兼容性矩阵与 P0 风险清单的人工确认 |
| Windows Job Object 限额 | 需要 Windows 进程限额实现 |
| Eino ADK | 运行时选型未切换 |

## 不可宣称

- 不能宣称 G0–G10 已全部签字。
- 不能宣称 CSR/mTLS 自动签发已上线。
- 不能在未配置正式证书时宣称安装包已受信任。
