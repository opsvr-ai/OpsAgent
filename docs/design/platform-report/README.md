# OpsAgent 平台全景汇报

打开 `index.html` 阅读（无需构建，`report.css` 同目录）。

## 覆盖内容

- 平台定位与控制面/运行时/连接层/数据层全景。
- 服务端架构：IAM、租户/RBAC、连接器、Plugin Store、知识、消息、任务、Commander、Agent Gateway、审计。
- 客户端 Agent：Go 单二进制、root + 动作门控、发现、1 天快照、CLI、mTLS/签名指令。
- 通信方式：Web/Control/Runtime/Connector/Host Agent/WeCom/Webhook/Model 的协议、认证、方向。
- 知识热更新：版本化索引、Redis/SSE 失效、下一 turn 生效、引用带版本、回滚。
- 运维场景：巡检/指标分析/故障诊断；发布/租户共享/平台共享。
- 创造模式：完整继承 dsh `cordis`，生成可安装 Cordis connector bundle。
- 消息中心、长任务/无人值守巡检、Commander/Evidence/Approval。
- 安全隔离、docker-compose、dsh 兼容、44 周路线图与创新点。

设计基线：`../00-platform-design.md`；计划：`../01-development-plan.md`。

## 配套深潜

`agent-commander.html`：Agent 能力、生命周期、内部架构、服务端架构、与 Commander 的协同协议、五个排障/部署示例、失败模式与路线图。

`os-agent-tech.html`：OS Agent 技术选型与落地设计：Go/单二进制、进程与权限、模块/代码结构、发现/采集/存储、gRPC/签名协议、打包/升级、测试/性能、风险。

