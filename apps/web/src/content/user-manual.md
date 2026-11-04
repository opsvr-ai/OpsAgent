# OpsAgent 用户手册

## 1. 快速开始

1. 使用本地管理员或 LDAP 账号登录。
2. 如果账号属于多个租户，在工作台左侧点击租户卡片切换。
3. 选择角色视角后点击“新建会话”。
4. 在会话框输入运维问题，例如“检查订单服务最近 15 分钟的错误率”。
5. 涉及写操作、重启、执行命令等 R2/R3 工具时，会话内会弹出审批。

## 2. 工作台与会话

- 工作台展示当前租户的事件、会话和快捷入口。
- 会话历史保留最近 50 个运行时会话。
- 会话流为 SSE，事件包括文本、工具调用、工具结果、审批和完成状态。
- 工具调用会展示风险等级；R2/R3 必须审批。

## 3. 场景中心

- 场景由步骤组成，可手写或由创造模式生成。
- 执行前会检查权限和步骤风险。
- R2/R3 步骤会挂起，等待审批后继续。
- 场景支持发布、定时调度和共享审批。

## 4. 审批

- 审批来源包括：运行时工具、场景步骤、场景共享。
- 审批页只展示当前用户有权处理的待审批项。
- 批准/拒绝会写审计；拒绝不会执行工具。
- 运行时审批在会话页也可以直接处理。

## 5. 集成与连接器

内置连接器：

- Prometheus
- Grafana
- Alertmanager
- Zabbix
- ClickHouse
- PostgreSQL
- MySQL
- Redis
- SSH
- HTTP

操作步骤：

1. 新建连接器，选择类型，填写名称和 Base URL。
2. 打开“详情”保存凭据 JSON，例如：
   - PostgreSQL：`{"connectionString":"postgres://..."}`
   - MySQL：`{"connectionString":"mysql://..."}`
   - SSH：`{"host":"...","port":22,"username":"...","password":"..."}`
3. 凭据使用 AES-256-GCM 加密，保存后不可回读。
4. 连接器 API 会对 config 中 password/token/privateKey 等字段脱敏。
5. 支持 `credentialRef`：
   - `env:VAR_NAME`：从环境变量读取 JSON
   - `file:/path/secret.json`：从文件读取 JSON

## 6. 数据沉淀

- 数据沉淀用于保存插件查询结果的本地快照。
- 数据集按工具能力聚合，展示快照数、大小和最后同步时间。
- “查询优先策略”支持本地优先、实时优先、仅本地、仅实时。
- 可设置同步周期、全量对账时间、新鲜度阈值和保留天数。
- “清理 dry-run”只统计，不删除；正式清理会写审计。

## 7. 知识中心

- 文档支持草稿、审核和发布。
- 发布需要 `knowledge.publish`。
- 审核需要 `knowledge.review`。
- 知识可被场景/Agent 作为上下文引用。

## 8. 消息中心

- 事件创建会生成租户消息。
- 运行时审批会生成待处理消息。
- 支持标记已读。
- 配置 `OPSAGENT_WEBHOOK_URL` 后，事件和审批会同时推送 Webhook。

## 9. 长任务

- 长任务在后台运行场景，适合耗时操作。
- 状态：queued、running、awaiting_approval、success、failed。
- 审批后继续；服务重启时 running 任务会标记 failed/interrupted，等待中的任务保留。

## 10. 操作系统智能体

### 10.1 能力

- 出站注册，不开放入站端口。
- 立即心跳，之后每 10 秒上报 CPU、内存、磁盘和 Agent 运行指标。
- 启动时与每 5 分钟执行配置发现：
  - 操作系统版本、内核、CPU/内存/磁盘、IP、时区、虚拟化、包管理器、监听端口
  - systemd 服务、Docker 应用、Windows 服务
  - Agent 版本、安装路径、服务名、配置路径、启动时间、能力
- 每 30 秒自巡航磁盘和内存，异常主动上报；恢复后自动标记恢复
- 主机自然语言问题会下发只读 `inspect` 命令：磁盘分区、CPU、内存、服务、端口、进程、软件包、网络、日志、容器、Agent 部署路径等
- 主动上报的告警会进入「操作系统智能体」页的告警区和消息中心
- 支持命令：
  - diagnostics
  - discovery（立即重新发现并刷新配置）
  - disk_check
  - memory_check
  - ai_diagnose（需要 Agent 所在机器配置模型凭据）
- 主机可按应用系统归属，平台按应用系统聚合和过滤。

### 10.2 一键安装

在“操作系统智能体”页点击“一键安装 Agent”，平台会生成 Linux/Windows 命令。

Linux：

```bash
curl -fsSL 'http://<control>/api/agents/install.sh?tenantId=...&token=...' | sudo bash
```

Windows（管理员 PowerShell）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr 'http://<control>/api/agents/install.ps1?tenantId=...&token=...' -UseBasicParsing | iex"
```

安装脚本会：

1. 下载对应平台 Agent 二进制。
2. 安装到 Linux 的 `/opt/opsagent` 根目录；Windows 使用 `C:\ProgramData\OpsAgent`。
3. 写入 enrollment token、租户和目录配置。
4. 注册 systemd 或 Windows 计划任务并启动。

Linux 标准目录：

```text
/opt/opsagent/
├── bin/opsagent-agent       主程序
├── config/agent.env         配置文件
├── tools/                   诊断辅助工具
├── logs/agent.log           详细执行日志（stdout/stderr 也在 logs）
├── snapshots/               配置发现、性能、自巡航、命令结果快照
└── run/                     运行状态目录
```

配置文件默认权限 `0600`，日志目录和快照目录默认 `0750`，由 Agent 启动时补齐。
日志包含启动、注册、心跳、HTTP 请求、自巡航、命令接收/执行/结果上传、快照写入和错误信息，并配置 logrotate 每日轮转、保留 14 份。

前置条件：

- 控制面必须配置 `OPSAGENT_AGENT_ENROLLMENT_TOKEN`。
- 控制面必须能提供 `agents/opsagent-agent/dist` 下的二进制。
- 可用 `OPSAGENT_PUBLIC_URL` 指定 Agent 可访问的平台地址。
- Agent 网络必须能出站访问控制面。

### 10.3 构建 Agent 分发文件

```bash
pnpm agent:dist
```

生成：

- `opsagent-agent-linux-amd64`
- `opsagent-agent-linux-arm64`
- `opsagent-agent-windows-amd64.exe`

## 11. 模型配置

- 支持 DeepSeek 和 OpenAI-compatible provider。
- API Key 使用 AES-256-GCM 加密，接口不返回明文。
- 租户配置会注入真实 dsh 会话和 Studio 生成器。
- 设置 `OPSAGENT_SECRET_KEY`；生产不要使用开发默认密钥。

## 12. 成员与角色

- 角色可多选，权限取并集。
- 不能移除租户最后一个 `tenant_admin`。
- 修改角色会写审计。

## 13. 平台管理

- 平台管理员可以查看和创建租户。
- 普通租户管理员无法访问平台租户 API。
- 平台管理员默认不需要选择租户。

## 14. 审计

- 记录登录、审批、连接器测试、场景执行、模型配置、成员变更等。
- 支持按 action/result 筛选。
- 支持 CSV 导出。
- 默认保留 180 天，启动时和每日清理。

## 15. 安全建议

- 生产必须设置 `OPSAGENT_SECRET_KEY` 和 `OPSAGENT_AGENT_ENROLLMENT_TOKEN`。
- 不要把 enrollment token 提交到仓库。
- 连接器优先使用外部凭据引用或加密凭据，不要明文写 config。
- 审批是最后一道防线，不要给普通账号 `connector.authorize` 和 `deployment.approve` 的无关组合。
- 对外部署时配置 HTTPS 和反向代理。

## 16. 故障排查

### 登录后一直回到登录页

- 检查 `/api/me` 是否 401。
- 检查 session cookie 是否被代理丢弃。
- 检查数据库连接和租户成员关系。

### 页面显示“加载失败”

- 打开浏览器 Network 查看对应 API 状态码。
- 检查 control 是否已重启并加载最新代码。
- 检查迁移是否执行、角色权限是否已 seed。

### Agent 不在线

- 检查 `OPSAGENT_CONTROL_URL` 和 `OPSAGENT_TENANT_ID`。
- 检查 enrollment token。
- 查看 Agent 日志和 systemd/计划任务状态。

### 安装命令返回 503

- 控制面没有配置 `OPSAGENT_AGENT_ENROLLMENT_TOKEN`。

### 安装脚本下载二进制 404

- 没有执行 `pnpm agent:dist`，或 `OPSAGENT_AGENT_DIST_DIR` 路径不对。

### AI 诊断返回 model_credentials_missing

- Agent 进程环境缺少 `DEEPSEEK_API_KEY`。
- 可选设置 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL`。

## 17. 已知限制

- 真实外部 Prometheus/Grafana/Zabbix 等需要用户自备环境。
- AI 诊断依赖外部模型服务。
- MySQL live 验证当前使用 MariaDB 兼容实例。
- 设计稿部分高级配置为近似实现。
