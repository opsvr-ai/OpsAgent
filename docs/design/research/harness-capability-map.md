# deepseek-harness 能力地图与运维平台集成建议

> 调研对象：`deepseek-harness`（仓库根 `deepseek-harness/`，版本 `0.2.2-alpha.2`，MIT）。下文路径均相对该仓库根目录，`<harness>/` 即 `E:\dev\OpsAgent\deepseek-harness\`。结论来自源码与随包文档阅读，未做运行期验证；"实验性"标注对应 `packages/experimental/`。

## 0. 结论先行

1. **它不是"一个 agent 库"，而是一棵可组装的 Cordis 插件树**：agent loop、工具、模型适配、会话日志、沙箱、Web/桌面壳都是插件，产品入口只有 `dsh` CLI 的一个 profile（`packages/bundle/README.md`、`docs/architecture.zh.md`）。
2. **最稳的扩展面是"包 + bundle patch + profile"，不是改 agent-loop**：仓库明确要求新行为挂到文档化扩展点，改 loop 必须同步 `docs/architecture.md`（`AGENTS.md#conventions`）。
3. **会话是事件溯源的 JSONL 日志**，`session.vN.jsonl[.zstd]` 按 cwd 分目录、只追加、格式版本当前为 v4，跨版本只做相邻迁移（`docs/session-format-status.zh.md`、`packages/session/session-persistence-jsonl/README.md`）。
4. **SQLite 不是会话主存储**：会话在 JSONL；SQLite 只用于可选 KV 后端（`storage-sqlite`，document-per-row）与可选 FTS5 检索（`session-query-sqlite`）。base 组合里检索索引甚至是 `:memory:` + `openAt: never`（`packages/bundle/base/cordis.patch.yml:157-161`）。
5. **模型层同时具备 DeepSeek Messages 适配器与 pi-ai 多协议适配器**，后者已覆盖 `openai-completions` / `openai-responses` / `anthropic-messages`，自定义 provider 用配置即可，不写代码（`packages/llm/llm-pi-ai/README.md`、`packages/llm/llm-pi-ai/src/catalog.ts:340-344`）。
6. **当前只有"单 owner"身份模型**：浏览器用一次性 launch token 换签名 Cookie，principal 只有 `{kind:'owner'}` 与 liveshare 的 `share-viewer`，没有 user_id / 租户 / 登录态（`packages/client/connection/README.md:39-53`、`.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md:34`）。
7. **多租户不能靠配置解决**：会话目录、`.credentials.yaml`、`storages/`、`profiles/<name>` 全部以单个 `DSH_HOME` 为根，且 credential 是明文文件（`0o600`，无加密）（`packages/util/home-paths/README.md`、`packages/credentials/credentials-local/src/index.ts:687-703`）。
8. **服务端只能 stdio 或"单机 Web 壳"**：SDK 是 stdio 上的 JSON-RPC，Web 是 loopback/单 IP + Cookie 的 GUI；没有多用户 HTTP API、没有 OIDC、没有 RBAC 用户体系（`packages/sdk/server/README.md`、`packages/bundle/web-app/README.md#public-deployments`）。
9. **推荐采用 C 方案（harness 作为独立 agent 运行时服务，被平台按会话调用）+ 薄 bundle 插件层**；仅当必须做平台级多用户 UI/多租户隔离时才 fork，且 fork 点应集中在 API/connection 与持久化 seam，避免动 agent-loop（见 §8）。

## 1. 运行时组成与编程启动

### 1.1 分层职责

| 层 | 包 / 目录 | 职责 | ctx key |
|---|---|---|---|
| 会话事实 | `packages/core/session` | 追加式 `SessionEvent` 日志、内存 Store、`fork`、`flush` | `ctx.sessions` |
| Agent 契约 | `packages/core/agent` | `Agent` 句柄、活跃注册表、`agent/*` 事件、`agent.ctx` 作用域 | `ctx.agents` |
| 驱动实现 | `packages/core/agent-loop` | 默认驱动：create/resume、turn/step 状态机、模型请求、工具派发 | `ctx.agentLoop`（注册 `AgentFactory`） |
| 工具 | `packages/core/tools` | 作用域注册表、schema 投影、`defineTool`、守卫/策略流水线、执行器选择 | `ctx.tools` |
| 提示词 | `packages/core/system-prompt` | 提示词片段与工具 schema 组装 | `ctx.systemPrompt` |
| 模型 | `packages/llm/*` | 供应商无关流式服务 + 适配器 + 重试 + 计量 | `ctx.llm` |
| 组装 | `packages/preset/*` | 按 Session 选择一套子插件（preset） | `ctx.agentPresets` |
| 分发层 | `packages/bundle/*` | 可安装的 patch 层（base/web-app/headless/sdk-app/acp-app/sdk-minimal） | — |
| 启动 | `packages/boot/app-boot`、`apps/cli` | profile 解析、层叠、Loader 启动、`dsh` bin、`profile-boot` 导出 | — |
| 宿主 | `packages/host/*` | Web 宿主服务：HTTP、静态 dist、目录选择、插件清单 | `ctx.webServer` 等 |
| 远程调用 | `packages/api/*` | Typert RPC BFF、会话/设置/工作区控制器、peer 访问控制 | `ctx.typertGateway`、`ctx.remote` |
| SDK | `packages/sdk/{protocol,client,server}` | stdio 上的 newline-JSON-RPC 协议/客户端/服务端 | 无 ctx key（函数插件 `sdk-jsonrpc-server`） |
| Python | `python/{sdk,sdk-runtime}` | 同协议 Python 客户端 + 打包 `dsh` 的 wheel | — |

证据：`docs/architecture.zh.md#core-packages`、`packages/README.md#package-groups`、`packages/sdk/README.md`、`python/README.md`。

### 1.2 profile / bundle / patch：一个运行实例是怎么拼出来的

- 一个 **profile** 位于 `$DSH_HOME/profiles/<name>`，含 `package.json`（`dsh.profile.bundles` 有序列表）与 `cordis.patch.yml`（用户补丁层）；随发行版提供 `web`、`headless`、`sdk`、`sdk-minimal`、`acp` 五个模板（`apps/cli/README.md:34-47`）。
- 一个 **bundle** 在自身 `package.json` 用 `dsh.bundle.patch` 声明 patch 文件；`web/headless/sdk/acp` 都叠在 `dsh-base`（`packages/bundle/base`）之上，`sdk-minimal` 是完整独立树（`packages/bundle/README.md`）。
- 层叠顺序：各 bundle patch（按 `dsh.profile.bundles` 顺序）→ profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlay；一条 patch 按 entry id 替换整个 config 或插入新 entry，preset patch 在目标 `config.plugins` 内同规则生效（`docs/architecture.zh.md:17-27`）。`dsh-hmr` 监视 manifest 与两层 patch，`headless/sdk/acp` 禁用它、改配置需重启（`:27`）。
- 启动器是唯一受支持入口：`dsh <profile>`；`packages/boot/app-boot` 提供 `boot()`/`installFailLoud()`，`apps/cli` 暴露 `@deepseek-ai/dsh/profile-boot` 给 Desktop Host 与 embedder 复用（`apps/cli/package.json:170-177`、`packages/boot/app-boot/README.md:36-50`）。
- 启动器有"必需 entry"集合：`agent-loop`、`tool-executor-native`、`tool-executor-ptc`、`webserver`、`web-runtime`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`，任一失败则整树 disposal 并非零退出（`packages/boot/app-boot/README.md:43`）。

`dsh-base` 的实际组成可直接读 patch：模型（`llm`、`llm-deepseek-*`、`llm-pi-ai`）、会话与持久化（`session`、`session-persistence-jsonl`、`attachment-local`、`session-query-sqlite`）、工具（`tools` + 两个 executor + bash/pwsh/fs/jobs/subagent/workflow/skill/web/mcp）、沙箱（`sandbox-local` + `sandbox-policy` + `bash-sandbox`/`fs-sandbox`）、审批与权限（`user-approval` + `permission-presets`）、凭据/设置/遥测（`credentials-local`、`settings`、`config-editor`、`otel`）（`packages/bundle/base/cordis.patch.yml`）。

### 1.3 一个 Session 如何创建、恢复、持久化

- 创建：`ctx.sessions.create(sessionId, { meta: { cwd } })` 得到内存 Session；`ctx.agents.create({ sessionId, agentOptions, setup })` 由 factory 建 Session + Agent，返回唯一可 teardown 的 `AgentHandle`（`packages/core/session/README.md:30-40`、`packages/core/agent/README.md:32-43`）。
- 恢复：`ctx.agents.resume(sessionId)` 从持久化后端加载日志、修复中断尾部、重建 Agent；模型选择沿用已记录值（`packages/core/agent-loop/README.md:57-61`）。SDK/Web 的"冷恢复"由 session-controller 的 `agent`/`session` lookup 做去重（`docs/api-gateway.zh.md:134`）。
- 持久化：`dsh-session` 本身只在内存；`dsh-session-persistence-jsonl` 订阅 `session/event` 落盘，首次 append 时独占发布并 `fsync`，此后每批 append 追写 + `fsync`，失败回滚文件长度；`ctx.sessions.flush(session)` 是显式耐久屏障（`packages/core/session/README.md:86-88`、`packages/session/session-persistence-jsonl/README.md:57-77`）。
- fork：`ctx.sessions.fork(source, boundary?, childId?)` 复制一段包含前缀，补 `TOOL_NOT_STARTED`/`TOOL_OUTCOME_UNKNOWN` 结果并封口，`isSeeded` + `inheritedEventCount` 表达继承（`packages/core/session/README.md:80-84`）。
- 事件即事实：`turn/start|end`、`step/start|end`、`user/message`、`assistant/message|attempt`、`tool/call|result` 等是持久事件；`agent/*`、`tools/*`、`fs/*`、`llm/*` 是实时扩展点（`docs/architecture.zh.md#events`、`docs/persistence-catalog.zh.md`）。

**一次 turn 的执行序列**（`docs/architecture.zh.md:87-110`）：

```text
turn/start → [agent/pre-step 接纳/改写/拒绝] → step/start
  → agent/request（已弃用，仅存量监听器）→ ctx.llm.prepareCall() 绑定适配器
  → 记录 request/header（+ 必要时 request/context）
  → 从日志派生历史 → ctx.llm.stream() → agent/assistant-stream（实时 chunk）
  → assistant/message 或 assistant/attempt（提交 settlement）
  → tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
  → step/end → step 仍有欠账或新输入则继续 claim → agent/turn-stopping → turn/end
```

平台可挂钩的位置：`agent/pre-step`（改写/拒绝入参）、`agent/request-error`（重试）、`agent/turn-stopping`（续跑）、`tools/pre-execute`（审批/脱敏）、`tools/post-execute`（结果改写）、`session/event`（审计/遥测）、`agent/assistant-stream`（仅实时 UI，不能作为重放源）。注意 `agent/request` 已弃用，新代码不要挂（`packages/core/agent/README.md:78`）。

### 1.4 以编程方式启动一个 Agent 会话（4 条路径）

| 方式 | 入口 | 传输/进程 | 适用 |
|---|---|---|---|
| A. SDK JSON-RPC | `dsh --profile sdk` + `@deepseek-ai/dsh-sdk-client`（或 Python `deepseek-harness-sdk`） | stdio，newline JSON-RPC；客户端 spawn `dsh` 子进程 | 平台后端最合适：可控进程、可快照、多 session |
| B. ACP | `dsh --profile acp` | stdio，标准 Agent Client Protocol v1 | 标准自动化客户端，不暴露 DSH 私有 UI 能力 |
| C. headless 一次性 | `dsh --profile headless "task" [--json] [--session-id id]` | 进程内一次任务，stdout 最终答案，退出码 0/1 | 定时任务、CI、脚本化运维动作 |
| D. 进程内嵌入 | `@deepseek-ai/dsh/profile-boot`（等价 `app-boot`）启动 profile，然后 `ctx.agents.create()` | 同进程，TypeScript | 自建 Node 服务内嵌；非公开稳定 API |

SDK 的完整方法集（`packages/sdk/protocol/README.md:36-63`）：client→server `initialize`、`session/prompt`、`session/query`、`session/resume`、`session/wait`、`session/working-directory/get|set`、`shutdown`；server→client `approval/request`、`user-question/ask`、`session.event`（**全量未过滤**）、`session.status`、`session.query.completed`、`subagent.started|finished`。

```ts
// 平台侧伪代码：每租户一个受控子进程，进程内按 sessionId 复用
const child = spawn('dsh', ['--profile', 'sdk'], {
  env: { ...env, DSH_HOME: `/var/lib/dsh/tenants/${tenantId}` },
  stdio: ['pipe', 'pipe', 'pipe'], // stdout 只能是 JSON-RPC 帧
})
// initialize → session/resume 或直接 session/prompt { sessionId, contentBlocks }
// 消费 session.event / session.status；approval/request 由平台审批中心应答
```

要点：`dsh-sdk-server` 用 stdout 承载协议，禁止 stdout 日志（`packages/sdk/server/README.md:70-72`）；`initialize` 是就绪边界，会等待整棵插件树 settle（含 MCP 首轮工具发现）；一个进程可开多个 `sessionId`；`session/resume` 对缺失/不兼容/占用会拒绝且不会新建替代（`packages/sdk/server/README.md:32-34,76-78`）。

## 2. 扩展点

### 2.1 "插件"到底指什么

Cordis 插件两种形态：函数插件（命名导出 `name`/`inject`/`Config`/`apply`）或 `Service` 子类 default export；服务占据稳定 `ctx.<key>`，依赖用 `inject` 声明；**所有注册都是可逆副作用**（`ctx.effect()` / `ctx.on()`，dispose 即撤销），事件分 `emit`/`waterfall`/`parallel`/`serial`/`bail` 五种分发（`docs/cordis-primer.zh.md`、`packages/AGENTS.md`）。不要混用两种导出形态（会导致 `inject` 丢失，`docs/postmortem/0001-acp-default-export-drops-inject.md`）。

工具的注册、schema 呈现、执行流水线、能力 seam 的完整定义见 `docs/architecture.zh.md#capability-seams`：一个 seam 由 Service Definition / Provider / Consumer 三角色构成，替换 provider 即可整体换实现（例如把 `ctx.fs`/`ctx.subprocess`/`ctx.sandbox` 指向远端沙箱）。

### 2.2 工具：注册、呈现、执行

- 注册：`ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`；注册即进入系统提示词 schema（`packages/core/tools/README.md:30-64`）。schema DSL 支持 string/number/integer/boolean/null/array/object/json/oneOf，原始 JSON Schema 走 `JsonSchemaNode`。
- 条件工具与按 agent 收窄：`register(def, { when })` 每个 step 求值一次（executor 与 PTC 绑定同时受影响，`:66-73`）；`ctx.tools.restrict({ allow | deny })` 或挂到 `agent.ctx`（`packages/core/agent/README.md:72-74`）。
- 执行流水线：`tools/pre-execute`（allow/deny/ask waterfall）→ 单调 guards → `tools/execute`（超时/重试包装）→ `tools/post-execute` → `finalizeContent` → `tools/result`（`:112`）。
- 呈现与执行器：Host 侧 `presentCall()`/`presentResult()` 是纯函数，Web 侧不用它们而按 `tool.call.toolview` 与裸事件渲染（`packages/core/tools/README.md:96-99`）；执行器二选一——`native`（模型直接看到所有工具）或 `ptc`（模型只见 `run_code`，工具以生成的 SDK 在沙箱 Node 进程里调用）（`:75-84`、`docs/tool-catalog.zh.md`）。

### 2.3 skill

`ctx.skills` 是 provider 注册表，模型侧 `skill` 工具按需加载正文；本地 provider 扫描 `<projectRoot>/.agents/skills`（rank 200）、`$DSH_HOME/skills`、`$DSH_AGENTS_HOME`（默认 `~/.agents`）与可选 bundled 根（rank 600），支持 `<name>/SKILL.md` 或平铺 `<name>.md`，要求 YAML frontmatter `name`/`description`，并 watch 热更新（`packages/skill/skill-filesystem/README.md:36-55,99-109`）。运维场景可把"变更评审手册""故障处理 runbook"做成 skill 目录，按租户挂载。

### 2.4 MCP

`dsh-mcp-client` 每 entry 一个 server，`transport: stdio | streamable-http`，工具名 `mcp__<serverName>__<tool>`，支持 `headers`（可注入 token）、每调用超时（默认 60s）、自动重连退避、`failOnStartupError`（`packages/mcp/mcp-client/README.md:30-71`）。资源发现/读取另由 `dsh-mcp-resources` 提供（`mcp__*` 之外的 3 个 `*_mcp_resource*` 工具）。对运维平台，**接入既有 Zabbix/Prometheus/Grafana MCP server 是零代码路径**。

### 2.5 subagent / workflow / 团队

- subagent provider 接口下可选：`spawn-in-process`、`fork-in-process`（继承父历史）、`acp`、`codex`、`claude-code`、`dsh-sdk`（跨进程真 Harness 子级）（`packages/subagent/README.md`）；模型侧 `subagent`、`list_subagent_models`、`send_message`、`interrupt_agent`、`list_agents`（`docs/tool-catalog.zh.md`）。
- `workflow` 工具让模型写编排脚本，在 PTC 沙箱 Node 进程里 fan-out subagent 并返回最终值（`packages/workflow/README.md`）；实验性 Agent Teams 提供持久 roster + 共享任务板（`packages/experimental/agent-team`），但不等同于平台级多租户。

### 2.6 新增一个调用外部系统（如 Zabbix）的工具：需要实现什么

最小闭环 = 一个工具包 + 一个 profile patch 行（必要时一个 bundle）。

1. 新建工具包（仓库内可放 `packages/<组>/tool-zabbix`，平台侧也可以是完全独立的 npm 包，包名任意），`package.json` 依赖 `@deepseek-ai/dsh-tools`（peer `@deepseek-ai/cordis`）。
2. 实现函数插件：`name`、`inject: ['tools', 'credentials']`、`Config`（`baseURL`、`apiKeyEnv` 等用 schemastery 声明，禁止把可调参数写死）、`apply(ctx)` 内 `ctx.tools.register(defineTool(...))`。
3. 工具定义要点：`parameters` 用 DSL 严格声明；`output.schema` 只声明真实返回；`execute` 只返回声明值；`timeoutMs` 是声明式上限（需挂 `tool-call-timeout-policy` 才强制）；只有 `isConcurrencySafe(args)` 返回 `true` 才允许并行；`execute(args, exec)` 必须转发 `exec.signal`。
4. 凭据：**不要**把 token 放 config 明文，声明 `apiKeyEnv` 并 `await ctx.credentials.resolve(credentialRef(cfg.apiKeyEnv))`，由 credential seam 分层解析（stored file > 环境 > `.env`）。
5. 审批：写操作可在 `tools/pre-execute` 返回 `ask`，由 `ctx.approval` 向 answerer 请求一次性许可；或用 `ctx.tools.guard()` 做硬拒绝。只读查询通常不必审批，但在 `never` 策略下同样会被拒。
6. 呈现：可选 `presentCall`/`presentResult`；若要在 Web 出卡片，另加 `toolview` 渲染器（`packages/core/tools/README.md:96-99`）。
7. 配置：在目标 profile 的 `cordis.patch.yml` 加一行 `- id: tool-zabbix` / `name: '@your/tool-zabbix'` / `config: {...}`；写操作默认只挂到特定 preset/agent scope，而不是全局。
8. 验证：仓库要求"产品可见插件"跑真实组合测试（Loader + app/process，mock 仅外部服务），并补 Model Experience 段（`packages/AGENTS.md`、`docs/testing.zh.md`）。

```ts
// 骨架：packages/extensions/tool-zabbix/src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'tool-zabbix'
export const inject = ['tools', 'credentials']

export interface Config {
  baseURL: string
  apiKeyEnv: string
  timeoutMs: number
}
// 真实实现用 Schemastery：export const Config: Schema<Config> = Schema.object({ … })

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'zabbix_problems',
    description: 'List active Zabbix problems for a host group.',
    parameters: {
      group: { type: 'string', required: true, description: 'Zabbix host group' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'array', items: { type: 'object' } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const hit = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv))
      if (!hit) throw new Error('MISSING_CREDENTIAL')
      const res = await fetch(`${config.baseURL}/api_jsonrpc.php`, {
        method: 'POST',
        signal: exec.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${hit.value}` },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'problem.get', params: { group: args.group, limit: args.limit } }),
      })
      return res.json() as Promise<unknown[]>
    },
  }))
}
```

### 2.7 插件配置 与 cordis.yml / profile 的关系

`cordis.yml`（含 patch 文件）是唯一装配面：每条 entry 有 `id`、`name`（包名或文件 URL）、`config`、`disabled`、`group`/`include`；`!!js` 仅在 `config` 与 `disabled` 内插值（`docs/cordis-primer.zh.md:41-51`）。plugin-manager / `dsh plugin` 在 profile 目录里跑 pnpm 安装树外插件，写入 `package.json` 的 `dsh.profile.bundles`，并要求 `engines.dsh`/peer 范围匹配（`apps/cli/README.md:37-39`、`packages/boot/app-boot/README.md:52-56`）。设置页的可编辑字段是插件用 `.volatile()` 声明的字段，写入的是**当前 profile 的 patch**（`packages/settings/settings/README.md:12,37`）。

### 2.8 扩展点速查（想做 X 该挂哪里）

| 目标 | 机制 | 证据 |
|---|---|---|
| 加模型供应商 | 在 `ctx.llm` 注册适配器（`registerAdapter`） | `docs/architecture.zh.md:150-171` |
| 加面向模型的工具 | `ctx.tools.register(defineTool(...))`，schema 自动进提示词 | `packages/core/tools/README.md:30-64` |
| 让某会话有不同能力集 | agent preset（YAML 子插件行，需 `isolate` realm） | `packages/preset/agent-preset/README.md` |
| 加 shell 执行后端 | 注册 `ctx.shell` 后端 / `ctx.subprocess` | `docs/architecture.zh.md:155` |
| 加持久终端 | `ctx.terminals` 后端 + `tool-terminal` | 同上 |
| 加用户命令 | `ctx.commands`（无需模型轮次） | 同上 |
| 拦请求/工具/轮次 | `agent/*`、`tools/*` 事件（waterfall 必须调 `next()`） | `docs/architecture.zh.md:162` |
| 注入模型可见上下文 | `agent.inject()`，落到下一次获准请求 | 同上 |
| 外部 webhook 起会话 | `ctx.webhookRuntime` 注册可信规则 + provider | `packages/experimental/webhook` |
| 换持久化后端 | 实现 `SessionPersistence`（`create/open/stat/list/export`） | `packages/session/session-persistence` |
| 按 agent 收窄工具 | `ctx.tools.restrict` 或挂到 `agent.ctx` | `packages/core/tools/README.md:86-88` |

## 3. 模型层

### 3.1 现状

| 包 | 角色 |
|---|---|
| `packages/llm/llm` | 供应商无关服务：`ctx.llm.stream()`、`prepareCall()`、`listProviders/listModels`、能力解析；每个流必有一个终止 `finish` chunk |
| `llm-deepseek` | DeepSeek Messages 协议传输（`baseURL` 默认 `https://api.deepseek.com/anthropic`，可被 `$DEEPSEEK_BASE_URL` 覆盖） |
| `llm-deepseek-api-key` / `-account` | 官方路由的两种鉴权与模型发现 |
| `llm-pi-ai` | 多 provider 适配器：pi-ai catalog + 手写网关；协议含 `openai-completions`、`openai-responses`、`anthropic-messages` |
| `llm-retry` | 在 agent-step 边界按 provider 策略重试（服务本身不重试） |
| `token-meter` | 从持久日志估算上下文压力 |

错误码稳定可路由：`NO_ADAPTER`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`（`packages/llm/llm/README.md:93-95`）。

### 3.2 baseURL / apiKey 配置

- DeepSeek 路由：`apiKeyEnv: DEEPSEEK_API_KEY`（credential 引用，**不是明文**），`baseURL` 可填 Messages 兼容网关；`reasoningEffort` 为 `off|low|high|max`（`packages/llm/llm-deepseek/README.md:41-58`）。
- pi-ai 路由：`providers.<route>` 下 `apiKeyEnv`、`baseURL`、`api`、`models`/`modelOverrides`、`compat`（如 `thinkingFormat`）、`defaultContextWindow`、`retryPolicy`；`baseURL` 可指向自建 vLLM/网关，`models` 是"整表替换"，`modelOverrides` 是局部修正（`packages/llm/llm-pi-ai/README.md:40-107`）。
- pi-ai 支持 OAuth/交互式 key 登录，凭据记录写到 `llm-pi-ai/<provider>`，带跨进程刷新锁；手写 route 名不合规会拒绝存储（`:93-99`）。
- 模型发现：catalog 已知路由不发网络；未知路由用 `GET {baseURL}/models`（OpenAI）或 `/v1/models`（Anthropic），只返回候选、不落库（`:113-115`）。

### 3.3 流式与工具调用

`ctx.llm.stream()` 产出 token 级 chunk（`block-start`、`text-delta`、`tool-call`、`usage`、`finish`），`BlockAssembler` 组装 content blocks；assistant message 内嵌紧凑带时间 stream，持久化供重放。工具调用作为 content block 往返，适配器负责各协议差异（thinking signature、`tool_addition`/`tool_removal` beta header 等，`packages/llm/llm-deepseek/README.md:85`）。工具并发由 `agent-loop` 的 `maxParallelToolCalls`（默认 10，1=串行）决定（`packages/core/agent-loop/README.md:55`）。

### 3.4 新增一个自定义 provider 的两条路径

**路径 1（推荐，零代码）**：在 `settings` 的 `llm-pi-ai` 段（或 profile patch 的同名 entry config）里加 `providers.<route>`：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      zabbix-llm-gw:
        displayName: Ops LLM Gateway
        api: openai-completions        # 或 openai-responses / anthropic-messages
        baseURL: https://llm.internal/v1
        apiKeyEnv: OPS_LLM_API_KEY     # credential 引用，逐请求解析
        models:
          - id: ops-72b
            name: Ops 72B
            contextWindow: 131072
            maxTokens: 8192
            reasoningEfforts: { off: null, high: high }
        compat:
          thinkingFormat: deepseek
```

pi-ai 的 route 名必须是小写连字符标识；catalog 未描述的路由必须给 `api`+`baseURL`+非空 `models`，否则在写入处即拒绝（`packages/llm/llm-pi-ai/README.md:28-38,117-123`）。模型能力（上下文、输出上限、reasoning efforts）由该段声明，`prepareCall()` 在发请求前校验，非法 effort 不会落到 wire。

**路径 2（写适配器）**：当协议不在 pi-ai 覆盖范围（例如私有 gRPC 或需要非 HTTP 传输）时，新建包并在 `ctx.llm` 注册 adapter，实现 `listModels`、`resolveModelInfo`、`prepareCall`、`stream`，把供应商 wire 翻译成 harness 的 `Message`/`ContentBlock`/`StreamChunk`；参考 `docs/cookbook/adding-an-llm-adapter.md`。该包同样通过 profile patch 的一行挂载。

## 4. 持久化与隔离

### 4.1 各存储的位置与内容

| 内容 | 位置（默认） | 格式 | 作用域 |
|---|---|---|---|
| Session 日志 | `$DSH_HOME/sessions/--<normalized-cwd>--/<encoded-id>/session.vN.jsonl[.zstd]` | 追加 JSONL，v4 当前版，zstd 帧带校验和 | 每会话一目录 |
| 会话检索索引（可选） | `session-query-sqlite.path`；base 默认 `:memory:` + `openAt: never` | SQLite FTS5（schema version 8） | 进程/部署 |
| 非会话 KV | `$DSH_HOME/storages/`（storage-json）或 `storage-sqlite.path` | 每表一 JSON 文档/行；domain 有版本戳 | 部署 |
| Workspace 实体 | storage domain `workspace`（Web 层） | 记录：目录、标题、顺序、session 归属 | 部署 |
| 凭据/授权记录 | `$DSH_HOME/.credentials.yaml` | 明文 YAML，`0o600`，目录 `0o700`；无加密 | 部署 |
| 设置 | 当前 profile 的 `cordis.patch.yml`（经 config-editor） | YAML | 每 profile |
| 匿名身份 | `$DSH_HOME/.anonymous-user-id` | 随机 UUID 文本 | 每 `DSH_HOME` |
| 附件/图片 | `$DSH_HOME/attachments/v1` | 内容寻址对象，按字节去重 | 每机器 |
| Profile | `$DSH_HOME/profiles/<name>/` | package.json + cordis.patch.yml | 每 profile |
| 工作目录/沙箱根 | `sandbox-policy.workspaceRoot` 默认 `process.cwd()` | YAML | 每组合 |

证据：`packages/bundle/base/cordis.patch.yml:113-200,240-247`、`packages/session/session-persistence-jsonl/README.md:59-77`、`packages/storage/storage-sqlite/README.md:56-80`、`packages/session-query/session-query-sqlite/README.md:36-50`（FTS DDL 见 `src/schema.ts:106-127`，`SESSION_QUERY_SQLITE_SCHEMA_VERSION = 8`）、`packages/credentials/credentials-local/README.md:12,69-80`、`packages/identity/anonymous-user-id/README.md:12`。

### 4.2 Session 格式与 SQLite schema 要点

- JSONL 物理头版本 = 文件名版本；已提交 generation **不重命名/不覆盖/不删除**；新格式写入 `vN` 后继，读旧格式先 Decode 再按相邻链迁移（v0→v1→v2→v3→v4），只读 open 不发布后继，写 open 才发布（`docs/session-format-status.zh.md`、`packages/session/session-persistence-jsonl/README.md:85-91`）。
- `storage-sqlite` 物理表：`unit_globals` 与每 unit/表的 `u_<unit>_<table>(key TEXT PRIMARY KEY, value TEXT)`，物理布局版本在 `PRAGMA user_version`（`packages/storage/storage-sqlite/README.md:71-80`）。
- FTS 索引是**派生库**：`search_state`、`persisted_sessions`、虚拟表 `persisted_docs USING fts5(...)`；不能指向会话存储库；表名不符会直接拒绝打开（`packages/session-query/session-query-sqlite/src/schema.ts:87-127`）。

### 4.3 是否存在 user_id / 租户

不存在。可核对的事实：

- `packages/identity/anonymous-user-id` 只有"每 `DSH_HOME` 一个匿名安装 id"，明确禁止用于识别用户或跨 home 关联（`README.md:28`）。
- 凭据存储、settings、workspace registry、session 根目录都以单个 `DSH_HOME` 为单位，没有 tenant/user 维度（`packages/util/home-paths/README.md:34-52`、`packages/bundle/base/cordis.patch.yml:113-200`）。
- 服务端 principal 只有 `{kind:'owner'}` 与 liveshare 的 `share-viewer`；`api-remote-access` 的 role/binding 是**方法级 RBAC**，但 principal 种类不是用户体系（`.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md:26-56`）。
- 另有一条"DeepSeek 账号"链路（`llm-deepseek-account`、`credentials/deepseek-account-platform`），是**模型供应商计费账号**，不是平台用户身份。

### 4.4 要做多租户隔离，应该加在哪一层

**推荐外层隔离（不改 harness）**：每租户一个进程/容器 + 独立 `DSH_HOME` + 独立 OS 用户/挂载卷。这是唯一与当前代码假设自洽的隔离方式：`DSH_HOME` 已经被所有持久化路径与匿名 id 使用，替换它即可分区；进程边界同时隔离了 Cordis 全局服务、native 锁与凭据文件。

若必须单进程多租户（代价大，需 fork）：

| 层 | 需要新增 | 现有证据 |
|---|---|---|
| Session 持久化 | 根路径按 `<tenant>/<user>` 分区，或实现 `SessionPersistence` provider 带 tenant 维度 | `packages/session/session-persistence-jsonl` 的 `root` 是单值配置 |
| 会话模型选择/归属 | `SessionHeader` 增加 tenant/user 字段（改 `SessionEventMap`/格式版本，需迁移） | `docs/session-format-status.zh.md` |
| 凭据 | 每租户一份 store 或外部 Vault provider；禁止共享 `.credentials.yaml` | `packages/credentials/credentials-local` |
| 设置 | provider 按 tenant 目录路由（当前写 profile patch） | `packages/settings/settings/README.md:12` |
| Workspace | domain 记录增加 tenant，并在 `workspaceController` 过滤 | `packages/workspace/workspace` |
| 会话检索 | FTS 库按 tenant 分区或加列过滤 | `packages/session-query/session-query-sqlite` |
| 认证/授权 | 新 principal 种类 + `remoteAccess.registerPolicy` 策略 | `packages/api/remote-access` |
| 遥测/审计 | 资源属性带 tenant/user，集中导出 | `packages/session/session-telemetry-otel` |

### 4.5 sandbox 与文件系统边界

- `ctx.sandbox` 是**同内核/同文件系统**的进程约束：`read-only` / `workspace-write` / `danger-full-access`；执行后报告 `full|partial` 强制完整度，无法强制时 `SANDBOX_UNAVAILABLE` 失败关闭（`packages/sandbox/sandbox/README.md:52-70`）。Linux 用 bwrap/Landlock，macOS Seatbelt，Windows ACL（`packages/sandbox/sandbox-local/README.md`）。
- 文件工具由 `dsh-fs-sandbox` 按同一模式做**策略围栏**（非内核边界）：`workspace-write` 只允许 workspace/额外根/临时目录，读不受限（`packages/fs/fs-sandbox/README.md:12,28-66`）。shell 与 fs 共用同一执行世界，`sandbox-policy.workspaceRoot` 默认是进程 cwd（`packages/bundle/base/cordis.patch.yml:243-247`）。
- 结论：运维场景中"读"是敞开的（可读整个宿主机文件系统），隔离必须靠容器/远端执行器替换整套 `ctx.fs`/`ctx.subprocess`/`ctx.sandbox`，或逐场景收紧 `workspaceRoot` + 只读挂载。

### 4.6 数据生命周期与备份

- 会话日志：已提交 generation 永不重写、不删除；压缩/裁剪只改变"模型可见投影"，原始事件保留（`packages/core/session/README.md:52-56`、`docs/architecture.zh.md:128-134`）。备份 = 拷贝 `sessions/` 目录；恢复 = 同版本或更高版本读取 + 相邻迁移，**不支持降级**。
- 附件与检索索引：`attachments/v1` 内容寻址、自动去重、**从不自动删除**、不跨机器（`packages/attachment/attachment-local/README.md:12,55`）；FTS 索引是纯派生数据，schema 版本不匹配时整库 DROP 重建（`packages/session-query/session-query-sqlite/src/schema.ts:56-100`），可从会话日志重建、不必备份。
- 凭据：明文 YAML，备份即泄露；建议接入外部 secret provider 或至少把 `DSH_HOME` 与审计卷分离。
- 升级面：会话格式 `latestFinalizedVersion: 4`、`latestReleasedVersion: 4`，格式变更走"相邻迁移 + 生成目录 + 快照更新"的硬门禁（`docs/session-format-status.zh.md`）。平台跨版本升级前应先跑旧日志的只读打开与 resume 回归。

## 5. 服务端与客户端

### 5.1 包职责

| 位置 | 职责 |
|---|---|
| `packages/api/remotes` | 选择哪些 Host 能力/事件向 Client 暴露（BFF 装配） |
| `packages/api/gateway` | Typert RPC dispatcher：一元调用、`/api/remote.mux` 多路复用 WS 流、事件转发 |
| `packages/api/{session,settings,workspace,job,terminal,account}-controller` | 领域 Remote 方法 + Session/Workspace 身份策略 |
| `packages/api/remote-access` | 非 owner Peer 的方法级访问决策（role/binding/resource） |
| `packages/api/workspace-files` | 工作区文件 stat/分页 read/list/changes |
| `packages/host/webserver` | `node:http(s)` 路由表、升级路由、TLS、SPA fallback 座位 |
| `packages/client/connection` | RPC 载体、`/api` 信任栅栏、browser Cookie 认证 |
| `packages/client/*` | 浏览器半侧 UI 插件（React） |
| `apps/web` | Vite 构建的 Web 壳（`@deepseek-ai/dsh-client-web` 的应用入口），dist 由 `dsh web` 的 fallback 提供 |
| `apps/desktop` | Electron 壳，加载打包 Web，经私有 IPC 连到已认证 Host |
| `apps/desktop-host` | Electron 的 Node 模式 Host（private 包），跑同一 CLI profile runner |
| `apps/cli` | 唯一 `dsh` bin、profile 启动、插件管理 |
| `packages/sdk/*` | 跨进程 stdio JSON-RPC |
| `apps/plugin-market-generator` | 发布侧工具：生成插件市场索引文件 |

### 5.2 对外协议

- HTTP：`POST /api/<namespace>/<method>`（一元 Remote）；精确 Fetch 路由处理非 RPC 响应（下载、上传、静态资源）；SPA fallback（`docs/api-gateway.zh.md:128-136`、`packages/host/webserver/README.md`）。
- WebSocket：Gateway 的 `/api/remote.mux` 承载 Remote 流与上行；会话事件流是独立数据协议，不伪装成 Remote 方法（`docs/api-gateway.zh.md:168`）。
- stdio：SDK JSON-RPC（newline-delimited）与 ACP。GUI 侧**没有**一等 SSE 协议（webserver 只在压缩策略里提到 SSE 例外），不要按 SSE 设计平台对接。
- 所有 Remote 调用都过 Connection 的 Host/Origin 栅栏与 Peer 认证；未认证 401，越权 403（`packages/client/connection/README.md:39-49`）。

### 5.3 当前认证方式

单机单用户模型，链路是"一次性 token → 签名 Cookie"：

1. 进程启动生成随机 launch token，`dsh web` 打印/打开 `?token=...`；`authorizeIndex` 只接受 `GET /` 上的该 token，写 authority 绑定的签名 Cookie 并 302 到干净 `./`，之后所有 RPC/WS 都要求该 Cookie（缺失/过期/错 authority 一律 401）。
2. Cookie 的签名密钥是 credential 记录 `client-connection/browser-session`（本地 provider 存在 `.credentials.yaml`），Cookie `HttpOnly`、`SameSite=Strict`、`Path=/`、有效期默认 30 天，TLS 下 `Secure`。
3. API 调用方另走 `GET /connect?token=...&interactions=answer|none`，同样签发 owner principal 的签名 Cookie；Host/Origin 栅栏要求 Host 为 loopback、监听地址本身或 `trustedHosts` 条目，`sec-fetch-site: cross-site` 拒绝，`dsh web --host 0.0.0.0` 不支持。
4. 没有 logout：删 Cookie 只结束单个浏览器；撤销所有会话要删 credential 记录并重启（`packages/client/connection/README.md:41-83`）。

### 5.4 做多用户登录要改哪里

- 认证：替换 `BrowserAuth` 的 token/Cookie 逻辑，加 OIDC/OAuth 回调路由与 session 校验（`packages/client/connection/src/browser-auth.ts`）；`connection/admit` 从 Cookie 解出 principal。
- 身份：扩展 `Principal` 种类（当前 `owner`/`share-viewer`），给 gateway 的每次调用带 user/tenant（`.agents/notes/...peer-principal-and-remote-access.md`）。
- 授权：用 `ctx.remoteAccess.registerPolicy(kind, policy)` 实现真实策略（role→resource/action），并补 `allows()` 列表过滤；当前只有方法级、非 owner 的结构，缺少用户/角色存储。
- 数据：按 §4.4 分区；会话查询/恢复必须校验归属，否则任意 `sessionId` 可被同进程所有者读取（`session-controller` 的 lookup 只做恢复，不做租户校验）。
- UI：`client/ui-settings-account`、`api/account-controller` 已有账号页骨架，但对接的是 DeepSeek 平台账号，不是平台自己的用户体系。

### 5.5 一次 Web 调用的实际链路

```text
浏览器 GET /?token=…            → connection.authorizeIndex：验 launch token，写签名 Cookie，302 ./ 
GET /, /assets/*               → frontend-static fallback（静态资源公开，index 注入 table）
Client 插件挂载                → 读 index 注入的 __DSH_REMOTE_ACCESS__ 基线
POST /api/<ns>/<method>        → api-request-trust（Host/Origin 栅栏）→ admit(Cookie) → peer(owner)
                               → typertGateway 校验 args → lookup 解析(agent/session) → 业务服务方法
订阅会话/Agent 流               → WS /api/remote.mux（gateway 多路复用）；follow 流名为 session/follow、session/control、workspace/follow
```

要点：非 owner Peer 在 exact Fetch 路由上会被 403，除非该路由自己声明访问规则；`$events` 只把策略允许的广播帧发给非 owner，且非 owner 不能回答 waterfall（`packages/api/remote-access/README.md:86-90`）。

### 5.6 Desktop 与 Web 的差异

- Web：`node:http(s)` 监听 loopback 或单个具体 IP，浏览器加载 Vite dist；Cookie 认证；无 Linux 桌面包。
- Desktop：Electron 用 `file://` 加载打包 dist，fetch/WS 经 IPC/本地 Host 转发，Host 绑定 `127.0.0.1` 且端口由 OS 分配，认证由桌面 carrier 拥有（`packages/host/webserver/README.md:12`、`packages/client/connection/README.md:30`、`apps/desktop/README.md:38-40`）。对平台的含义：Desktop 不适合做 SaaS 控制台，Web 需自建多用户鉴权才能上网，两者复用同一套 `packages/api` + `packages/host`。

## 6. 安全

| 机制 | 现状 | 对运维场景的风险 |
|---|---|---|
| sandbox | 三模式 + 升级审批；无法强制时失败关闭；Windows ACL 与旧 Landlock 报 `partial` | `danger-full-access` 等于无约束；`partial` 不能当强隔离；读操作永不围栏 |
| 审批策略 | `ask`（默认，走 answerer waterfall）/`never`（确定性拒绝）；`auto` 由实验性 auto-review 提供 | 无人在场时 `never` 会拒掉写操作；`ask` 无 answerer 时结果是 `unavailable`，同样失败关闭 |
| permission presets | `workspace-write`（默认）/`danger-full-access`，把 sandbox+approval 绑成一组，会话级 pin | 切到 full access + never 后运维 agent 可无确认改生产文件 |
| 凭据 | `.credentials.yaml` 明文 `0o600`，进程同用户可读；文档明说无法隔离 agent | 任何 bash/tool 进程都能读走 API key；容器内多租户共享 = 灾难 |
| 工具面 | bash/pwsh、fs、终端、MCP stdio、plugin_manager（装任意 npm 包）、computer-use/browser-use | MCP stdio = 任意本地命令；plugin 安装 = 供应链入口；终端工具是持久 shell |
| 审计 | 审批询问/决定/策略写会话事件（`approval/asked`、`approval/decided`、`approval/policy`）；OTel 会话遥测默认 `FEEDBACK_ONLY` | 审计在会话日志里、无集中审计库；配置变更走 patch，无 admin 审计 |
| 网络 | Host/Origin 栅栏防 DNS rebinding/CSRF；非 loopback 需 TLS 或反代 | 明文 HTTP 非 loopback 会泄露 Cookie |

### 6.1 运维平台的最小安全基线（基于现状可落地）

1. 默认权限预设设 `read-only` 或 `workspace-write`（`permission-presets` 支持自定义表），写操作显式审批；禁止默认 `danger-full-access`。
2. 每个租户容器只挂载自己的 `DSH_HOME` 与工作区卷；工作区卷以读写挂载，生产只读数据以只读卷提供。
3. 凭据不落 `.credentials.yaml`：要么挂外部 secret provider（`ctx.credentials` 是 seam），要么由平台注入短时 token 并通过 `apiKeyEnv` 引用。
4. 禁用不需要的高危插件行：`browser-use`、`computer-use`、`tool-terminal`、`plugin-manager`（`plugin_manager` 工具能装任意 npm 包）、`tool-cordis`（运行时改插件树）。
5. MCP server 白名单化：只允许平台注册的 server，stdio 命令与 env 由平台下发，禁止用户自填。
6. 审批答案由平台审批中心处理（SDK `approval/request` 或自建 answerer），并落平台审计库——会话内的 `approval/asked|decided` 只作旁证。
7. 打开 OTel 会话遥测到平台 collector（默认 `FEEDBACK_ONLY` 只上报反馈）并按租户打资源属性；网络层再加一层网关鉴权与限流，不要依赖 harness 的 Cookie 做用户身份。

## 7. 部署与许可

- **许可**：MIT（`LICENSE`、`THIRD_PARTY_NOTICES.md`），依赖为各自许可；`vendor/` 是重命名后的 vendored source。
- **运行时**：Node `>=24.9.0`，pnpm `11.28.5`（`package.json`），ESM only。
- **构建产物**：`pnpm run build` = `build:artifacts`（tsc 出 `lib/types`、tsdown 出 runtime、Vite 出 Web dist）+ `build:check`；各 npm 包以 `lib/*.js` + `lib/types` 发布；`@deepseek-ai/dsh` 对外的 exports 只有 `./profile-boot`、`./lib/*` 与 `./package.json`（根 `package.json`、`apps/cli/package.json:170-177`）。
- **启动命令**：`dsh web`（默认 3080，loopback）、`dsh --profile headless "task"`、`dsh --profile sdk`、`dsh --profile acp`；开发 `pnpm run dev:web`/`dev:desktop`，生产 `start:web`/`start:desktop`。
- **Desktop**：Electron + electron-builder，打包目标仅 `mac arm64/x64`、`win x64`（`apps/cli`/root scripts），无 Linux 包；app.asar 内携带完整 dsh 生产运行时与独立 Python/Node/pnpm 发行版（`apps/desktop/README.md:38-46,98-112`）。
- **Python**：`python/sdk-runtime` 把 `dsh` CLI 打成平台 wheel，客户端默认 `dsh --profile sdk` 并要求显式 Harness home（`python/README.md:12-16`）。
- **容器化阻碍**：
  1. 仓库**没有 Dockerfile**（唯一 Dockerfile 是 ssh 测试 fixture），部署假设是"本机用户 + `$DSH_HOME` + 本地 OS 账号"。
  2. native 依赖：`node-pty`（PTY 工具）、`@deepseek-ai/node-addon-system`（Landlock/flock 预编译，Linux x64/arm64 有 glibc/musl 二进制）、`@vscode/ripgrep`；沙箱后端依赖内核能力（Landlock 需启用且 ≥ 特定 ABI；bwrap 需 user namespace），容器内可能只能报 `SANDBOX_UNAVAILABLE`（失败关闭）。
  3. Electron/Desktop 不适合容器；Web 壳需要浏览器，但服务端只需静态 dist。
  4. 监听地址不接受 `0.0.0.0`，必须给具体 Pod IP，外部经反代/`--public-url` + `--trusted-host`（`packages/bundle/web-app/README.md:65-79`）。
  5. 单 owner Cookie 认证：容器里只能服务一个用户/一个租户，不能直接当多用户 SaaS 的 Web 层。
- **能否作为独立服务跑在容器里**：可以——以 `sdk`（或 `headless`/`web`）profile 跑"agent 运行时"容器，每租户一个容器 + 独立卷（`DSH_HOME`），由平台经过 stdio 或反代调用；**不可以**直接把当前 Web 形态当多用户 SaaS 前端。
- 官方文档给出的容器姿势（Web profile）：`dsh --profile web --no-open --host "$(hostname -i | awk '{print $1}')" --public-url https://app.example/ --trusted-host app.example`（`packages/bundle/web-app/README.md:69-79`）。镜像内需预装 Node 24、已构建的 dist 与各包 `lib/`、以及随包的 ripgrep 二进制；`sandbox` 行按目标内核选择 bwrap/Landlock，验证不到就保持失败关闭而不是关沙箱。
- 构建/测试门禁对升级很重要：`test:snapshot`（无密钥录制回放）、`test:expected`、`test:coverage`（对 `packages/*/*/src` 单文件 100%）、`doc-sync`（`AGENTS.md#Commands`）。平台做"换镜像升级"时应至少跑 `test:snapshot` 与自建会话回归。

## 8. 缺口与选型建议

### 8.1 缺口清单

| 能力 | harness 现状 | 缺口 |
|---|---|---|
| 多租户 | 单 `DSH_HOME`、单 owner、全局 workspace/credential/settings | tenant/user 维度、归属校验、配额与计费 |
| LDAP/OIDC | 无；只有 launch token + Cookie；另有 DeepSeek 账号 OAuth（供应商计费） | IdP 接入、账号/会话管理、登出/撤销 |
| RBAC | `api-remote-access` 提供方法级 role/binding/resource 与列表过滤；工具可按 agent restrict | 用户/角色/租户存储、管理面、默认拒绝策略、审计联动 |
| 插件市场 | `plugin-market` 读索引 + `plugin_market` 工具 + `pluginManager.installBundle`（pnpm 安装） | 签名/审核/租户白名单/离线镜像/回滚 |
| 审计日志 | 审批三事件 + 会话事件 + OTel 遥测（默认只上报反馈） | 集中审计管道、管理员操作审计、不可抵赖存储、保留策略 |
| 多用户 Web | 单机 GUI，无登录态 | BFF 多用户鉴权、会话归属、按用户过滤 |

### 8.2 三种复用方式对比

| 维度 | A. Fork monorepo 深度改 | B. 作为 npm 依赖嵌入自建后端 | C. harness 作为独立 agent 服务被平台调用 |
|---|---|---|---|
| 做法 | 改 `packages/api`、`client/connection`、持久化、加 tenant 字段 | 依赖已发布包，自建 Node 服务 `import('@deepseek-ai/dsh/profile-boot')` 启动 profile，进程内 `ctx.agents` 驱动 | 每租户一个 `dsh --profile sdk`（或 headless）容器/进程，平台用 SDK JSON-RPC 或 ACP 调用；自定义工具/技能以 bundle/plugin 包挂入 |
| 多租户 | 可达，但需改格式、迁移、全量评审 | 仍受单 `DSH_HOME` 限制，只能靠"每进程一租户"绕开 | 天然"每租户一进程/容器"，隔离最强 |
| 升级上游 | 冲突面最大（loop/API/持久化都在动，且 API pre-stable） | 中：需跟随包版本与 Typert 生成产物，pre-stable 会破 | 小：只依赖 SDK/ACP 协议与 bundle patch，升级=换镜像重放测试 |
| 交付速度 | 慢（要读懂 370+ 个包并维护分叉） | 中（要维护自己的启动器与打包） | 快（复用官方镜像/CLI，平台只做编排与工具） |
| 风险 | 分叉长期漂移；每次上游迁移都要重放 | 公开 API 明确"pre-stable"，内部包无兼容承诺（`AGENTS.md`） | SDK 只支持 stdio、无鉴权、`session.event` 全量广播，需要在进程/容器层补齐 |
| 适合 | 平台级多用户 UI、深度品牌/策略改造 | 单租户私有化、已有 Node 后端想复用 loop | 多租户 SaaS/私有化的默认形态 |

补充：B 的"官方"形态其实是 **自己写一个 bundle 包 + profile patch，然后用 `dsh` profile 启动器跑**——`apps/cli` 明确只支持 profile 启动，`profile-boot` 导出是给 Desktop Host 这类宿主复用的，不是稳定的第三方嵌入 API（`apps/cli/README.md:60-62`、`AGENTS.md#application-launch`）。因此 B 只在"承认自己维护一个分叉启动器"的前提下成立。

### 8.3 推荐

**主方案：C + 薄插件层（按需吸收 B 的一部分）。**

- 平台侧：每个租户一个 agent 运行时容器（或进程），镜像内为固定版本的 `@deepseek-ai/dsh` + 官方 profile；挂载租户独立 `DSH_HOME` 卷；平台网关负责鉴权、RBAC、配额、审批、审计，SDK 子进程只允许平台后端发起。
- 自定义能力：把 Zabbix/CMDB/工单等封装为 `tool-*` 包（或直接接 MCP server），在自建 bundle 的 `cordis.patch.yml` 里声明；skills 放 `$DSH_AGENTS_HOME`/`$DSH_HOME/skills` 做 runbook；用 `permission-presets` 收窄默认权限（例如默认 `read-only`，写操作走审批）。
- 平台对接协议：优先 SDK JSON-RPC（同进程可多 session，事件/审批/用户问题都能回流），需要标准协议时再开 ACP，不要用 headless 做主通道（一次性、无会话内交互）；升级用固定镜像版本 + 会话重放回归，自定义工具包只依赖 `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools`，避免依赖内部包。

**仅在这些条件下 fork（A）**：必须提供平台统一的 Web 多用户 UI（不能每用户一个容器）、必须单进程多租户、或需要改会话格式/归属。此时 fork 点顺序建议：
1. `packages/client/connection`（认证/principal）+ `packages/api/remote-access`（RBAC）——收益最高、耦合最低。
2. `packages/api/session-controller` + `packages/session/session-persistence-jsonl`（tenant 分区 + 归属校验）。
3. `packages/credentials` / `packages/settings` / `packages/workspace`（租户化）。
4. 最后才动 `packages/core/session` 的 `SessionEventMap`/格式版本——一次格式变更会触发迁移链与全部快照测试。

**不建议**：把 `packages/core/agent-loop` 当作定制点，或在平台里直接依赖 `packages/*/src`；仓库对 loop 的改动有强文档约束和大量快照/持久化门禁（`AGENTS.md`、`docs/testing.zh.md`）。

### 8.4 分阶段落地路线

**P0（1–2 周，验证可行性）**

- 单容器跑 `dsh --profile sdk`，平台用 supervisor 进程管理，打通 `initialize`/`session/prompt`/`session/resume`/`approval/request`；用 pi-ai 接自建 OpenAI 兼容网关验证流式、工具调用与 reasoning 参数。
- 接一个只读 Zabbix MCP server，验证 `mcp__*` 工具与 `ask`/`never` 两种审批行为。

**P1（4–6 周，产品化）**

- 写 `tool-*` 包（Zabbix 查询、CMDB 资产、工单读写），只依赖 `dsh-tools` 与 `dsh-credentials`，不碰 loop。
- 自建 bundle `ops-base`：在 `dsh-base` 之上禁用高危行（terminal/browser-use/computer-use/plugin-manager）、挂 ops skills、设 `read-only` 默认权限预设、声明 MCP 白名单，并用 patch 层固定。
- 平台审批中心接 SDK `approval/request`，`session.event` 全量转存平台审计库，打开 OTel 到平台 collector；每租户容器化 + 独立 `DSH_HOME` 卷 + 配额 + 网络白名单。

**P2（可选，3 个月以上）**

- 只有当必须做统一 Web 多用户控制台或单进程多租户时，才评估 fork（按 §8.3 的 fork 顺序）或等待上游能力（§8.5）；插件市场只接内部 registry 与白名单 bundle，且不要给模型 `plugin_manager` 工具（它能装任意 npm 包）。

### 8.5 值得向上游提的能力（按收益排序）

1. `SessionHeader` 增加 tenant/user（或"外部主体"）字段与归属校验钩子——多租户的地基。
2. `connection` 的可插拔认证（OIDC/OAuth），`Principal` 可扩展。
3. `remoteAccess` 的 principal 种类与角色/绑定存储对外开放（当前只有 owner/share-viewer）。
4. SDK 传输扩展到 TCP/WebSocket（当前仅 stdio），便于平台侧无子进程对接。
5. 集中审计导出器（审批/工具/配置变更事件推到外部 sink），而不是只进会话日志。
6. plugin market 的签名/来源校验与租户白名单。

### 附录：关键证据索引

| 主题 | 首要文件 |
|---|---|
| 架构与扩展点 | `docs/architecture.zh.md`、`packages/README.md`、`docs/cordis-primer.zh.md` |
| 组合/启动 | `packages/boot/app-boot/README.md`、`apps/cli/README.md`、`packages/bundle/base/cordis.patch.yml` |
| Agent / loop | `packages/core/agent/README.md`、`packages/core/agent-loop/README.md`、`docs/agent-lifecycle.zh.md` |
| 会话与格式 | `packages/core/session/README.md`、`packages/session/session-persistence-jsonl/README.md`、`docs/session-format-status.zh.md` |
| 工具 | `packages/core/tools/README.md`、`docs/tool-catalog.zh.md`、`docs/tool-execution-pipeline.zh.md` |
| 模型 | `packages/llm/README.md`、`packages/llm/llm/README.md`、`packages/llm/llm-pi-ai/README.md`、`packages/llm/llm-deepseek/README.md` |
| 持久化 | `docs/persistence-catalog.zh.md`、`packages/storage/storage-sqlite/README.md`、`packages/session-query/session-query-sqlite/README.md` |
| API/服务端 | `docs/api-gateway.zh.md`、`packages/api/README.md`、`packages/host/webserver/README.md`、`packages/client/connection/README.md` |
| 认证/访问控制 | `packages/api/remote-access/README.md`、`.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md` |
| SDK/ACP | `packages/sdk/protocol/README.md`、`packages/sdk/server/README.md`、`packages/acp/acp/README.md`、`python/README.md` |
| 安全 | `packages/sandbox/sandbox/README.md`、`packages/interaction/user-approval/README.md`、`packages/interaction/permission-presets/README.md`、`packages/fs/fs-sandbox/README.md` |
| 部署/许可 | `LICENSE`、`package.json`、`apps/desktop/README.md`、`packages/bundle/web-app/README.md` |
