# 操作系统智能体 `/opt/opsagent` 目录规划（Eino）

日期：2026-11-05
状态：已落地 Agent `0.4.1`

## 目标

把 `/opt/opsagent` 从“主程序 + 配置文件”升级为可承载 Eino 智能体运行时的标准目录：

- 技能可安装、可枚举、可被模型调用
- 记忆可持久化
- Eino 会话可持久化
- Runner checkpoint 可恢复
- 工具和脚本有独立工作区
- 日志、审计、快照不混放

## 目录

```text
/opt/opsagent/
├── bin/
│   └── opsagent-agent
├── config/
│   └── agent.env
├── skills/
│   ├── system-overview/SKILL.md
│   ├── disk-usage/SKILL.md
│   ├── memory-usage/SKILL.md
│   ├── network-status/SKILL.md
│   ├── service-status/SKILL.md
│   ├── process-top/SKILL.md
│   ├── logs-recent/SKILL.md
│   ├── container-status/SKILL.md
│   └── agent-health/SKILL.md
├── tools/
├── state/
│   ├── memory.json
│   ├── sessions/
│   └── checkpoints/
├── workspace/
│   └── scripts/
├── logs/agent.log
├── snapshots/
├── audit/
└── run/
```

## 与 Eino 的对应关系

| 目录 | Eino 组件 | 用途 |
| --- | --- | --- |
| `skills/<name>/SKILL.md` | `adk/middlewares/skill.LocalBackend` | YAML frontmatter + Markdown 技能说明 |
| `state/checkpoints/` | `compose.CheckPointStore` | Agent 中断/恢复 |
| `state/sessions/` | Runner session | 会话历史、运行状态 |
| `state/memory.json` | Agent 长期记忆 | 最近检查、技能观察 |
| `workspace/` | 文件/脚本工具 | 临时脚本和产物 |

`SKILL.md` 格式：

```markdown
---
name: network-status
description: 网卡、IPv4/IPv6、默认路由、DNS 和监听端口检查
---
# 网络检查
...
```

内置技能通过 `go:embed builtin-skills` 随二进制发布，首次启动写入 `skills/`，已存在不覆盖，便于现场二次编辑。

## 持久化实现

- 记忆：`state/memory.json`，滚动保留最近 50 条
- Checkpoint：`fileCheckpointStore`，key 使用 base64url 编码为安全文件名，原子重命名写入
- 会话：`state/sessions/` 预留，供 Eino Runner/ADK session 按 `sessionId` 保存
- 迁移：旧 `snapshots/memory.json` 自动复制到 `state/memory.json`，旧文件重命名为 `.migrated`

## 权限与隔离

- 目录 `0750`，文件 `0640`
- `workspace/scripts` 中脚本执行后删除
- 脚本执行仍受 `OPSAGENT_ALLOW_SCRIPTS` 和平台审批控制
- `skills/` 只有 Agent 用户可写，模型只读加载

## 可覆盖环境变量

```text
OPSAGENT_HOME
OPSAGENT_AGENT_CONFIG
OPSAGENT_LOG_DIR
OPSAGENT_SNAPSHOT_DIR
OPSAGENT_TOOLS_DIR
OPSAGENT_SKILLS_DIR
OPSAGENT_STATE_DIR
OPSAGENT_WORKSPACE_DIR
```

## 后续

- 将 ADK Runner 的 session/checkpoint 接入 `state/`
- 技能目录增加 `scripts/`、`references/`、`assets/` 子目录
- 按技能版本做升级和回滚
