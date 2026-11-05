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

审批来源：

- 运行时工具
- 场景步骤
- 场景共享
- Agent 服务启动 / 停止 / 重启 / 重载 / 启用 / 禁用
- 部署 / 回滚

操作说明：

- 批准 / 拒绝会写审计；拒绝不会执行工具。
- 运行时审批在会话页也可以直接处理。
- Agent 写操作审批支持单条批准、单条拒绝、撤销、批量批准和批量拒绝。
- 批量写审批由服务端事务完成：任一失败会整体回滚，不会出现部分执行。
- 审批默认 24 小时过期；过期前 1 小时会提醒；过期后不可执行。
- 可配置职责分离，禁止请求人审批自己的写操作。
- 过期、拒绝、取消和批准都会进入消息中心，并写入关联 Incident 时间线。
- “审批副作用失败”表示业务已成功但通知/时间线写入失败；可以点击“重试”或“标记已处理”。
- “审批 Webhook 投递失败”和“运维告警投递失败”可以手工重放；失败的投递会保留，成功投递按保留策略清理。
- 通知趋势支持 1h / 12h / 24h / 72h / 7 天、自定义时间范围、按小时/按天聚合、图例开关、缩放和 CSV 导出。

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
- 异常上报携带系统配置、指标、应用部署、应用/系统日志、进程和 Agent 日志诊断包
- 服务端收到节点异常后，自动检查该节点所属应用系统的全部节点，在「操作系统智能体」页生成根因定位卡片并写入消息中心
- 主机自然语言问题会下发只读 `inspect` 命令：磁盘分区、CPU、内存、服务、端口、进程、软件包、网络、日志、容器、Agent 部署路径等
- 支持路径/日志排查，如「看看 /opt/opsagent/logs 目录」「查看 /opt/opsagent/logs/agent.log 最后 50 行」；只读 exec allowlist 包含 ls/tail/cat/grep/find/ps/ss/journalctl/docker logs/systemctl status 等，写操作默认拒绝
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

生成命令前请确认 `OPSAGENT_PUBLIC_URL` 是目标 Agent 能访问的宿主机地址，例如：

```text
OPSAGENT_PUBLIC_URL=http://10.79.4.206:8080
```

- 不能填 `127.0.0.1`：那会指向 Agent 自己。
- 不能填 `control:8080`：那只在 Docker 网络内部有效。
- 修改 `.env` 后执行 `docker compose up -d control`，只 `restart` 不会重新读取。
- 目标 Agent 必须能访问该 IP 和端口，必要时放行防火墙。
- 使用域名/HTTPS 反向代理时填 `https://opsagent.example.com`。

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
5. 将 `/opt/opsagent/bin` 加入 PATH，并创建 `opsagent-agent` 命令。

安装后直接执行：

```bash
opsagent-agent
```

进入交互式对话，例如：

```text
opsagent> 磁盘分区什么样
opsagent> 当前纳管了多少操作系统智能体
opsagent> 订单中心健康情况和故障根因
```

后台服务使用 `opsagent-agent --service`，`--version`、`--help` 查看版本和用法。

CLI 通过 SSE 接收状态和回答增量，执行检查、生成结论时会实时显示进度。

CLI 问答会优先调用平台工具（纳管数据、应用健康、主机只读检查），再由 DshRuntime 模型基于真实证据生成回答；目标机 Go Agent 只执行只读探针，不持有模型密钥。

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
- 控制面必须能提供安装二进制；容器镜像默认内置在 `/opt/opsagent-agent-dist`。
- 可用 `OPSAGENT_PUBLIC_URL` 指定 Agent 可访问的平台地址。
- Agent 网络必须能出站访问控制面。

### 10.3 构建 Agent 分发文件

容器部署不需要手工编译：`docker compose build control` 会在 Go 阶段自动生成三个平台二进制，并放进镜像的 `/opt/opsagent-agent-dist`。宿主机不需要安装 Go。

内网构建前在 `.env` 中配置：

```text
NPM_REGISTRY=http://<nexus>/repository/npm/
GOPROXY=https://proxy.golang.org,direct
GOSUMDB=sum.golang.org
```

`NPM_REGISTRY` 同时用于全局 npm 安装和 `pnpm install`。没有 Go 代理时，在有网环境构建镜像后导入内网。

非容器开发或需要单独分发时：

```bash
pnpm agent:dist
```

生成：

- `opsagent-agent-linux-amd64`
- `opsagent-agent-linux-arm64`
- `opsagent-agent-windows-amd64.exe`

### 10.4 服务生命周期指令

在「操作系统智能体」详情页的「自然语言」页签可以向指定 Agent 下发：

```text
查看 nginx 服务状态
重启 nginx 服务
停止 nginx 服务
启动 nginx 服务
重载 nginx 服务
设置 nginx 开机启动
关闭 nginx 开机启动
```

只读的状态查询不需要审批。启动、停止、重启、重载、启用、禁用需要审批；
批准后控制面生成 Ed25519 签名命令，只有目标 Agent 能执行。

执行后 Agent 会检查实际状态：

```text
启动 / 重启 / 重载 → active
停止               → inactive
启用               → enabled
禁用               → disabled
```

状态不符合预期时命令标记 failed，结果会进入 Incident 证据和审计。

受保护服务（sshd、network、docker、containerd、kubelet、systemd 等）禁止操作。

### 10.5 资源限额

Linux：

```text
systemd MemoryMax / CPUQuota / IO 限额 / TasksMax
compose mem_limit / cpus
```

Windows 服务模式使用 Job Object：

```text
OPSAGENT_AGENT_MEMORY_LIMIT_MB=512
OPSAGENT_AGENT_CPU_PERCENT=50
```

限制会覆盖 Agent 子进程；未配置时不创建 Job Object。

## 11. 发布与流量灰度

### 11.1 主机级灰度

1. 在「发布与部署」创建签名 Release。
2. 创建部署计划，策略选择 `canary`，填写灰度比例。
3. 审批后执行制品预检。
4. 按比例选择 Agent 执行部署，状态变为 `canary`。
5. 点击「推进全量」部署剩余 Agent；失败会生成 Incident。
6. 出现异常时可回滚已灰度节点。

### 11.2 流量级灰度

流量级灰度控制入口流量，而不是 Agent 数量。

1. 在部署卡片点击「流量灰度」。
2. 填写入口域名、稳定上游、灰度上游和灰度比例。
3. 保存后平台生成 Nginx 配置。
4. 把配置应用到企业入口代理并 reload。
5. 观察错误率和延迟。
6. 使用 10% / 25% / 50% / 100% 调整；0% 回滚，100% 转正。

生成的核心配置：

```nginx
split_clients "${remote_addr}${request_id}" $order_example_com_backend {
    10% order_example_com_canary;
    *   order_example_com_stable;
}
```

注意：

- 控制面负责策略、配置生成和审计。
- 实际流量切换由入口代理执行。
- 修改配置后必须由入口代理 reload 才会生效。
- 入口域名不允许通配符。

## 12. 模型配置

- 支持 DeepSeek、OpenAI 兼容和 Anthropic API provider。
- 同一个 Base URL 可以保存多个模型。
- 添加模型时点击「发现模型」：
  - OpenAI 兼容：调用 `GET <BaseURL>/v1/models`（BaseURL 已含 `/v1` 时直接 `/models`）。
  - Anthropic：调用 `GET <BaseURL>/v1/models`，使用 `x-api-key` 和 `anthropic-version`。
- 发现结果用复选框选择，可一次保存多个。
- 发现失败不影响保存：可以手工填写模型 ID 后点击「添加模型」。
- 可以为同一租户配置多个模型；会话底部下拉框选择本次使用的模型。
- 默认选中最新创建的 active 模型；切换后下一条消息使用新模型。
- 没有配置模型时使用运行时默认模型。
- API Key 使用 AES-256-GCM 加密，接口不返回明文。
- 租户配置会注入真实 dsh 会话和 Studio 生成器。
- 设置 `OPSAGENT_SECRET_KEY`；生产不要使用开发默认密钥。

## 13. 成员与角色

- 角色可多选，权限取并集。
- 不能移除租户最后一个 `tenant_admin`。
- 修改角色会写审计。

## 14. 平台管理

- 平台管理员可以查看和创建租户。
- 普通租户管理员无法访问平台租户 API。
- 平台管理员默认不需要选择租户。

## 15. 审计

- 记录登录、审批、连接器测试、场景执行、模型配置、成员变更等。
- 支持按 action/result 筛选。
- 支持 CSV 导出。
- 默认保留 180 天，启动时和每日清理。

## 16. 安全建议

- 生产必须设置 `OPSAGENT_SECRET_KEY` 和 `OPSAGENT_AGENT_ENROLLMENT_TOKEN`。
- 不要把 enrollment token 提交到仓库。
- 连接器优先使用外部凭据引用或加密凭据，不要明文写 config。
- 审批是最后一道防线，不要给普通账号 `connector.authorize` 和 `deployment.approve` 的无关组合。
- 对外部署时配置 HTTPS 和反向代理。

## 17. 故障排查

### 查看控制面日志

```bash
docker compose logs -f --tail=200 control
docker compose logs --tail=200 control | grep -E '\[dsh\]|\[runtime\]'
```

常见日志：

```text
[dsh] start / stderr / exited / timeout
[runtime] prompt / dsh turn failed / dsh event error
```

API Key、Cookie 和 Authorization 会自动脱敏，提示词正文不写入日志。

### 登录后一直回到登录页

- 检查 `/api/me` 是否 401。
- 检查 session cookie 是否被代理丢弃。
- 检查数据库连接和租户成员关系。

### 页面显示“加载失败”

- 打开浏览器 Network 查看对应 API 状态码。
- 检查 control 是否已重启并加载最新代码。
- 检查迁移是否执行、角色权限是否已 seed。

### 安装脚本返回 curl: (22) 404

这通常不是安装脚本本身 404，而是脚本内部下载 Agent 二进制时 404。先在目标机确认：

```bash
uname -m
curl -i -sS -o /dev/null -w '%{http_code}\n' \
  'http://<control-ip>:8080/api/agents/binary?os=linux&arch=amd64&token=<token>'
```

排查：

- 确认 `OPSAGENT_PUBLIC_URL` 是宿主机 LAN IP，不是 `127.0.0.1`。
- 重新打开安装弹窗并复制新命令，旧命令可能带 `//api`。
- `x86_64` 用 `amd64`，`aarch64` 用 `arm64`。
- 确认 `OPSAGENT_AGENT_DIST_DIR` 下有对应二进制；容器镜像默认在 `/opt/opsagent-agent-dist`，非容器开发可执行 `pnpm agent:dist`。
- 新安装脚本会打印 `Downloading ... Agent binary from ...`，失败时打印完整 URL。
- 可在目标机保存脚本后用 `bash -x` 运行，定位具体失败行：

```bash
curl -fsSL '<install.sh-url>' -o /tmp/install.sh
bash -x /tmp/install.sh
```

### Agent 不在线

- 检查 `OPSAGENT_CONTROL_URL` 和 `OPSAGENT_TENANT_ID`。
- 检查 enrollment token。
- 查看 Agent 日志和 systemd/计划任务状态。

### 安装命令返回 503

- 控制面没有配置 `OPSAGENT_AGENT_ENROLLMENT_TOKEN`。

### 安装脚本下载二进制 404

- 容器部署请重新执行 `docker compose build control`，让镜像内的 Go 阶段重新生成二进制。
- 非容器部署执行 `pnpm agent:dist`。
- 检查 `OPSAGENT_AGENT_DIST_DIR` 路径和容器内文件是否存在。

### AI 诊断返回 model_credentials_missing

- Agent 进程环境缺少 `DEEPSEEK_API_KEY`。
- 可选设置 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL`。

## 18. 已知限制

- 真实外部 Prometheus/Grafana/Zabbix 等需要用户自备环境。
- AI 诊断依赖外部模型服务。
- MySQL live 验证当前使用 MariaDB 兼容实例。
- 流量级灰度只生成入口配置，实际切换需入口代理应用并 reload。
- OCSP 生产使用需要配置客户端可达的 AIA 域名和防火墙。
- Windows Job Object 限额已实现，需在 Windows 执行主机实机压测。
- 正式代码签名证书、十台混合主机和 G0–G10 人工签字需外部完成。

## 19. 证书、CRL 与 OCSP

平台使用内网 CA 或外部 CA 签发 Agent 客户端证书和控制面服务端证书。

### 19.1 查看证书状态

「平台证书」页展示：

- CA 证书
- 服务端证书到期时间
- Agent 证书状态
- 吊销记录
- 证书剩余天数

### 19.2 吊销

平台管理员可以吊销 Agent 当前客户端证书。吊销后：

- 新连接被拒绝
- 证书签发接口拒绝继续签发
- 生成新的 CRL
- 写审计

### 19.3 CRL

```text
GET /api/pki/crl
Content-Type: application/pkix-crl
```

### 19.4 OCSP

```text
POST /api/pki/ocsp
Content-Type: application/ocsp-request
Response: application/ocsp-response
```

或：

```text
GET /api/pki/ocsp/<base64url-request>
```

支持的证书状态：

- good
- revoked（含吊销时间）
- unknown

客户端证书包含 AIA OCSP 扩展；配置：

```text
OPSAGENT_OCSP_URL=http://control.example:8080/api/pki/ocsp
```

生产环境需要保证 OCSP 地址对证书使用方可达。
