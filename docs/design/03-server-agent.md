# Server Agent 设计（服务器智能体）

> 状态：设计评审稿；不写产品代码。
> 汇报材料：`docs/design/server-agent-report/index.html`
> 基线：`docs/design/00-platform-design.md`、`docs/design/01-development-plan.md`

## 1. 定位

Server Agent 是部署在每台服务器上的**本地操作员**：负责发现、观测、初步诊断和受控执行。它不是远程 Shell，不是无边界采集器，也不是替代服务端的“第二控制面”。

三条底线：

1. **Agent 只主动出站**，服务端不向主机开放入站端口。
2. **服务端下发动作 ID + 结构化参数**，不执行裸 Shell/自然语言拼出的命令。
3. **发现、采集、诊断默认只读**；重启、改配置、部署、升级属于 R2/R3，必须签名指令 + 审批 + 回滚。

### 1.1 与智能体框架的关系

- **客户端是轻量 LLM Agent**：Go 单二进制内置 Eino ADK Agent Runtime，循环为 Wake → Context → Plan → Act → Verify → Report → Sleep；模型走服务端 LLM Gateway，不把 dsh/Node/Python 运行时放到每台主机。
- **不是 dsh on host**：dsh 是服务端 Commander 的运行时；客户端不把 dsh 放到主机。
- **Eino ADK（Go）**：选用 CloudWeGo Eino 的 ADK/ChatModelAgent + Tool + compose Graph + interrupt/resume + callbacks；只做上下文、tool calling、类型化工具、预算、验证、证据；工具执行/审批/审计由 OpsAgent 薄封装，禁止 DeepAgent 的 shell/python 工具。
- **服务端 Commander 控制**：下发签名 Profile/Directive/DeployOrder；客户端按策略执行；R2/R3 仍需服务端审批；人类可暂停/接管/撤销。
- **日常巡航**：本地调度检查 OS/应用/服务/容量/日志/配置；异常先本地规则聚合，再触发只读 LLM 分析并上报；无任务时不调模型。
- **部署/升级**：P2-B 通过签名制品 + DeployOrder + 预检 + canary + 回滚执行；不是给 Agent 一个 Shell。
- 选型理由：Eino 是 Go 原生、Apache-2.0、13k+ stars、活跃维护的 LLM/Agent 框架，支持 ReAct、HITL、Graph、callbacks；生产机仍需静态二进制/低依赖/可审计，所以只使用其 ADK 组件，policy/executor 由 OpsAgent 掌握。服务端多 Agent 编排继续用 dsh。

## 2. 总体架构

```
服务端
  Agent Gateway（mTLS 长连接、指令、遥测）
  Enrollment / CA（令牌、CSR、轮换、吊销）
  Agent Registry / CMDB（主机、应用、数据中心）
  Policy / Skills（动作白名单、能力包、签名）
  LLM Gateway（OpenAI 兼容 / Anthropic；租户配额）
  Control Agent（Commander + 工具插件）
  Command / Evidence（审计、回执、证据）

                 ⇅ mTLS + 签名指令
主机
  opsagentd
    agent runtime / planner / model client
    discovery / collector / policy / executor
    deploy executor / local knowledge / snapshot ring / SQLite
  opsagent CLI（Unix socket ↔ daemon）
  OS / systemd / apps / containers / logs / config
```

服务端只信任：证书绑定的 host_id、签名指令、签名遥测。Agent 只信任：服务端 CA 签发的 Gateway 证书、带签名的策略/指令。

## 3. 生命周期

| 阶段 | 动作 | 产物 | Gate |
|---|---|---|---|
| 安装 | 释放二进制、systemd unit、目录、最小权限 | 自检报告 | 无业务数据访问 |
| 注册 | 一次性 join token → CSR → 设备证书 | host_id、证书 | 租户/网段/标签校验 |
| 发现 | 有界只读发现 | DiscoveryReport | 只读、限路径、限时 |
| 归属 | IP/主机名/CMDB 匹配 | App/DC 绑定 + 置信度 | 多候选不自动覆盖 |
| 基线 | 24–72h 轻量基线 | Baseline | 不影响业务 |
| 稳态 | 常驻采集、异常上报、CLI | 指标/快照/事件 | 资源预算 |
| 排障 | 服务端下发只读诊断 | 证据 + 结论 | 签名/超时/脱敏 |
| 扩展 | 技能包/工具包/二进制升级 | 灰度/回滚 | 签名/审批 |

状态机：`bootstrap → enrolled → discovering → steady → degraded / quarantined`。隔离状态只允许心跳与策略拉取。

## 4. 初始化与自动发现

### 4.1 发现范围

- OS：发行版、内核、架构、CPU/内存/磁盘/网卡、systemd、包列表、用户/组、cron、时区/时钟。
- 服务：systemd units、监听 socket、进程 cmdline、容器元数据、健康检查。
- 应用：二进制/启动命令、语言运行时、端口、依赖进程、配置目录、日志目录、版本文件。
- 部署方式：systemd / 容器 / Kubernetes / 裸进程 / 静态站点；启动用户、工作目录、环境文件路径（只记键名，不读值）。
- 配置/日志：路径、格式、最后修改时间、哈希、轮转策略、错误签名。
- 运维工具客户端：Zabbix Agent、node_exporter、filebeat、telegraf、falcon-agent、Datadog 等。
- 依赖：已有端口连接、父子进程、配置中上游地址（只读解析）。

### 4.2 应用识别

多信号 + 置信度，不靠单一进程名：

- 应用服务器：业务端口 + 业务配置 + 业务日志 + 应用进程 + unit/容器。
- 运维工具客户端：采集/转发/执行特征，不是业务应用。
- 数据库/中间件：MySQL、PostgreSQL、Redis、ClickHouse、Kafka 等单独建模。
- 低置信度标记 `ambiguous`；服务端/人工确认后才写入正式知识。

示例：`java -jar order-service.jar` + 8080 + `order.service` + `/opt/order/conf` + `/var/log/order` → 应用实例；只有 `java` 进程不构成结论。

### 4.3 发现边界

- 只读；禁止全盘遍历、端口扫描、网络探测、读取 `/etc/shadow`、读取密钥/完整环境变量、执行应用代码。
- 限定路径白名单、文件类型、大小、时间预算；大文件只读元数据/尾部。
- 容器 runtime socket 默认不接（root 等价）；需要时只读元数据，单独授权。
- 发现失败要显式标注，不静默用旧数据。

### 4.4 应用/数据中心归属

服务端匹配顺序：显式 Agent 标签 → CMDB IP/网段 → 主机名规则 → 人工确认。

- 返回候选 + 置信度；冲突进入复核，不静默覆盖。
- 本地知识保存副本、置信度、更新时间；服务端是主数据。
- IP 变更/克隆/迁移触发复核。

## 5. 常驻采集与快照

| 频率 | 数据 | 本地保留 | 上传 |
|---|---|---|---|
| 5s | CPU、内存、load、磁盘 IO、网络、进程 TopN | 1h | 异常窗口 |
| 30s | 服务状态、端口、连接、应用健康、线程/队列 | 6h | 摘要/异常 |
| 5m | 配置哈希、日志错误签名、依赖/版本变化 | 24h | 变化/摘要 |
| 按需 | 线程栈、日志尾、连接详情、配置片段 | 24h / 200MB | 任务结果 |

- 总磁盘上限 `min(1GB, 磁盘2%)`；80% 清旧高频，95% 停高频并告警。
- 本地 SQLite + 环形分区 + zstd；服务端不可达时只保留最近窗口。
- 目标：空闲 CPU <1%、内存 <100MB、磁盘写入 <5MB/s；纳入验收。

## 6. 能力边界

| 级别 | 动作 | 条件 |
|---|---|---|
| R0 只读 | status、metrics、日志尾、配置读（脱敏）、端口/连接检查 | 本地策略允许 |
| R1 低危 | 诊断包、线程栈、快照 | 本地策略 + 服务端任务 |
| R2 高危 | 重启服务、清理临时文件、切日志级别 | 签名指令 + 审批 + 回滚点 |
| R3 受控 | 部署/升级/改配置/扩缩容 | 未来；变更单 + 维护窗口 + 双人审批 |

自巡航（steady）默认只做 R0/R1。CLI 只能发起请求，不能本地批准 R2+。

## 7. 通信与安全

### 7.1 注册

1. 安装包带一次性 join token（短 TTL、单次、绑定租户/网段/标签）。
2. Agent 生成密钥对（优先 OS keystore/TPM），提交 CSR。
3. 服务端 CA 签发带 host_id/tenant_id 的客户端证书。
4. 自动/人工批准；未知主机隔离。
5. 短周期轮换；隔离/下线/重装即吊销。

### 7.2 指令信封

```json
{
  "command_id": "cmd_01J9...",
  "tenant_id": "t-1001",
  "host_id": "host_8f2a",
  "action_id": "diag.thread_dump",
  "params": {"pid": 1842, "max_bytes": 1048576},
  "policy_version": "pol_2041",
  "issued_at": "2026-11-03T14:52:31+08:00",
  "expires_at": "2026-11-03T14:57:31+08:00",
  "nonce": "b7f2...",
  "signature": "ed25519:..."
}
```

Agent 校验：mTLS 证书、签名、tenant/host、policy 版本、动作白名单、参数、过期、nonce replay cache、command_id 幂等。任何一项失败拒绝并审计。

### 7.3 威胁与防线

| 风险 | 防线 |
|---|---|
| 伪造服务端命令 | 双向 mTLS + KMS/HSM 签名 + 动作 ID 白名单 + 不接受自由文本命令 |
| 重放 | nonce + 短过期 + replay cache + command_id 幂等 |
| 错发主机/租户 | 证书绑定 host/tenant + 信封二次校验 |
| 伪造遥测 | 设备私钥签名批次 + 序列号/时间窗 + 网关校验 |
| 日志/配置提示注入 | 内容视为不可信数据；模型只提议，策略引擎决定动作 |
| Agent 密钥泄露 | 短证书、行为检测、隔离、吊销；高危动作二次审批 |
| 本机恶意用户 | CLI Unix socket + peer 凭证；daemon 默认 root 但动作门控；R2+ 服务端审批 |
| 供应链/升级 | 签名二进制/技能包、校验和、灰度、回滚 |

LLM 不持有模型 Key：Agent CLI/诊断走服务端 LLM Gateway，服务端做租户配额、脱敏、审计、路由。离线退化为本地规则与缓存知识。

## 8. 排障闭环

1. 本地检测（阈值/基线/连续次数/错误签名）→ 聚合去重。
2. 异常事件带证据：指标窗口、服务/端口、配置哈希、日志签名、变更、应用/DC、快照引用。
3. 服务端总控智能体关联主机、Prometheus/Zabbix、ClickHouse、DB、变更、知识。
4. 下发只读诊断任务（线程栈/日志/连接/配置/依赖），带预算/超时。
5. Agent 本地初步归因，回传证据 + 结论 + 置信度。
6. R2+ 审批；R3 变更单；人可接管。

服务端工具插件与主机 Agent 并行分析；结论必须引用证据，不能只有模型总结。

## 9. 服务端纳管

新增模块：Agent Gateway、Enrollment/CA、Agent Registry/CMDB、Policy/Skills、Telemetry Pipeline、Command/Evidence、Control Agent、Agent 管理 UI。

- 自动纳管 ≠ 自动信任：未知主机隔离；网段/标签/镜像签名满足才自动批准。
- 主机档案：IP/主机名/租户/数据中心/应用/Agent 版本/策略版本/状态。
- 应用画像合并：Agent 发现 + CMDB；冲突保留。
- Agent 类型：OS 先行；虚拟化/存储/网络作为插件，共用注册/策略/指令/审计协议。

## 10. 技术栈

- Go 单二进制：`opsagentd`（daemon）+ `opsagent`（CLI）。
- **轻量 Agent Runtime**：Eino ADK ChatModelAgent + 自定义 Tool + compose Graph（上下文/计划/工具/预算/验证/报告）；模型走服务端 LLM Gateway（OpenAI 兼容 tool calling）；只使用 ADK 组件，禁用 DeepAgent 的 shell/python 等危险工具，policy/executor 由 OpsAgent 薄封装。
- gRPC/HTTP2 + mTLS + protobuf；Agent 只出站。
- SQLite（无 cgo）+ 环形文件/分区 + zstd。
- Linux first：systemd、/proc、journald、dpkg/rpm、容器元数据；不加载内核模块，不依赖 eBPF。
- **daemon 默认 root**（采集/部署需要）+ 动作级权限门控；CLI 普通用户；systemd 纵深防护；不接 docker socket。
- 部署执行器：签名 DeployOrder/制品、预检、canary、健康检查、回滚；R3 审批。
- 交叉编译 amd64/arm64；签名升级、灰度、回滚。
- 资源目标：CPU <1% 空闲、内存 <100MB、磁盘 ≤1GB/2%。

### 10.1 安装 CLI 与服务端信息

安装时通过 CLI 传入服务端 IP/端口、租户、认证材料、资源限额：

```bash
opsagent install \
  --server 10.20.30.40:8443 \
  --tenant t-1001 \
  --join-token-file /root/opsagent-join-token \
  --ca-cert /root/opsagent-ca.pem \
  --cpu-quota 50% \
  --memory-max 256M
```

- `--server`：IP:port 或域名；IP 不加密，明文保存在 `server.address`。
- `--tenant`：租户 ID。
- `--join-token`：兼容直接传参，但更推荐 `--join-token-file` 或 stdin，避免进入 shell history/ps。
- `--ca-cert`：服务端 CA；生产禁止跳过校验。
- `--cpu-quota` / `--memory-max`：写入 systemd drop-in，见 10.2。

安装流程：

1. 预检：root/systemd/架构/磁盘/端口/CA。
2. 写基础配置（IP/租户/路径/限额），生成随机 master key。
3. 注册：join token → CSR → mTLS 证书；token 用后删除。
4. 将认证材料（如 gateway token、代理口令）用 master key 加密后写入配置。
5. 写 systemd 资源限额 drop-in，启动 `opsagentd`，健康检查。

### 10.2 资源限额

daemon 由 systemd/cgroup v2 强制限制，默认值可按安装参数覆盖：

```ini
CPUQuota=50%
CPUWeight=50
MemoryHigh=192M
MemoryMax=256M
MemorySwapMax=0
TasksMax=64
IOWeight=50
IOSchedulingClass=best-effort
IOSchedulingPriority=7
OOMScoreAdjust=200
```

- Go 运行时：`GOMAXPROCS=2`、`GOMEMLIMIT=200MiB`、`GOGC=50`。
- Eino Agent：单次最多 8–12 步、最多 12 次模型调用、并发工具 ≤4、上下文 ≤16k token；空闲不调用模型。
- 采集：空闲 CPU <1%、RSS <100MB、磁盘写入 <5MB/s；2 次采样超限自动降级/暂停高频采集。
- 磁盘：快照 `min(1GB, 磁盘2%)`；80% 清旧高频，95% 停高频并告警。
- 不限制业务进程；Agent 自身 OOM 优先于业务被杀（`OOMScoreAdjust=200`）。

Windows 服务模式使用 Job Object 限制自身和子进程：

```text
OPSAGENT_AGENT_MEMORY_LIMIT_MB=512
OPSAGENT_AGENT_CPU_PERCENT=50
```

- 内存使用 `JOB_OBJECT_LIMIT_JOB_MEMORY`
- CPU 使用 `JobObjectCpuRateControlInformation` 硬上限
- 子进程自动继承作业限制
- 未配置时不创建 Job Object

### 10.3 配置与敏感信息加密

配置文件 `/etc/opsagent/agent.yaml` 采用**字段级加密**，不是整文件加密：

```yaml
server:
  address: "10.20.30.40:8443"   # 明文；IP 不加密
  ca_file: "/etc/opsagent/ca.pem"
tenant:
  id: "t-1001"
auth:
  gateway_token: "enc:v1:..."    # AES-256-GCM
  join_token: "enc:v1:..."       # 仅注册重试需要；成功后删除
limits:
  cpu_quota: "50%"
  memory_max: "256M"
```

- 加密算法：AES-256-GCM；每条敏感字段独立随机 nonce；AAD 绑定 `tenant|server|field`，防跨主机/跨字段复用。
- master key：优先 TPM2/OS keyring 封装；无 TPM 时 `/var/lib/opsagent/keys/master.key` 0600，随机 32 字节，不写日志/不进 prompt。
- 私钥 `/var/lib/opsagent/pki/agent.key` 0600；可选 TPM/加密；不放在 YAML 里。
- 配置 0600、原子写、保留上一版；日志/CLI 输出统一脱敏。
- `opsagent config rotate-key` 轮换 master key；`opsagent enroll rotate` 轮换证书。
- 丢失 master key 不能恢复密文，需重新注册；这是有意的安全取舍。

## 11. 数据模型（本地/服务端镜像）

| 对象 | 关键字段 |
|---|---|
| Agent | host_id、tenant_id、cert_fingerprint、version、status、last_seen |
| HostProfile | hostname、ip、os、cpu/mem/disk、dc、app_system、tags |
| DiscoveryRun | run_id、scope、started_at、evidence_hash、confidence |
| ServiceInstance | unit/container、ports、process、user、health |
| AppInstance | name、type、deploy、config_paths、log_paths、ports、deps、confidence |
| OpsToolClient | type、version、endpoint、managed_by |
| MetricSample / Snapshot | ts、window、payload_ref、retention |
| Anomaly | rule、severity、evidence、app/DC、status |
| DiagnosticCommand | command_id、action_id、params_hash、expires、signature |
| KnowledgeBinding | app_system、dc、source、confidence、updated_at |

## 12. 扩展蓝图

- 应用部署/升级：签名制品、变更单、预检、canary、分批、健康检查、回滚；R3。
- 虚拟化/存储/网络 Agent：插件化，独立采集器/动作表，不共享 OS Agent 权限。
- 技能包/工具包：签名、版本固定、灰度、回滚；未签名拒绝。
- 不允许“给 Agent 一个万能 Shell”作为扩展方式。

## 13. 路线

P1/P1.5/P1.6 的 28 周不变。Server Agent 独立主线：

- **P2-A（12 周）**：Linux Agent、Eino ADK 轻量 Agent Runtime、注册/证书、受控发现、应用画像、常驻采集、日常巡航、异常分析/上报、CLI、Gateway/Registry。
- **P2-B（8 周）**：签名诊断指令、线程栈/日志/连接/配置检查、证据回传、总控编排、受控部署/升级（签名制品、预检、canary、回滚）、安全加固/灰度。
- **P3**：虚拟化/存储/网络 Agent 插件、跨设备协同、更复杂部署策略/可选本地推理。

P1.6 之后串行 P2-A/P2-B 需额外约 2.5 FTE；推荐串行以保安全评审。

## 14. 已确认

1. 首发 OS 范围：Linux 优先，Windows/macOS 后续。
2. Agent 权限：**默认 root + 动作级权限门控**；CLI 普通用户；无裸 Shell。
3. 自动纳管：令牌 + CSR，网段/标签自动，其他人工。
4. LLM 路径：统一服务端 Gateway，不落模型 Key。
5. 快照保留：**最长 1 天**：5s 1h / 30s 6h / 5m 24h；异常 24h·200MB；总上限 1GB 或 2%。
6. 写能力：P2-B 支持受控部署/升级（变更单 + 签名制品 + canary + 回滚）；不做任意 Shell。
