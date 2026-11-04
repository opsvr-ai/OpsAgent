import type { RuntimeEvent } from '@opsagent/contracts';
import type { Pool } from 'pg';
import { AgentCommandService, type AgentCommandRecord } from '../agents/commands.js';
import type { AgentEventRecord } from '../agents/events.js';
import { AgentEventService } from '../agents/events.js';
import { AgentService, type AgentRecord } from '../agents/service.js';

export type PlatformPlan =
  | {
      readonly kind: 'inventory';
      readonly query: string;
      readonly appSystemId?: string;
      readonly appSystemName?: string;
    }
  | {
      readonly kind: 'alerts';
      readonly query: string;
    }
  | {
      readonly kind: 'host-alerts';
      readonly agent: AgentRecord;
      readonly query: string;
    }
  | {
      readonly kind: 'agent';
      readonly agent: AgentRecord;
      readonly query: string;
      readonly mode: 'inspect' | 'discovery';
    };

function value(input: unknown): string {
  if (input === null || input === undefined || input === '') return '—';
  if (Array.isArray(input)) return input.join(', ');
  if (typeof input === 'object') return JSON.stringify(input);
  return String(input);
}

function rounded(input: unknown, digits = 1): string {
  if (typeof input === 'number' && Number.isFinite(input)) return input.toFixed(digits);
  return value(input);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relativeTime(input: string | null): string {
  if (!input) return '未知';
  const time = new Date(input).getTime();
  if (Number.isNaN(time)) return input;
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export class PlatformAssistant {
  constructor(
    pool: Pool,
    private readonly agents = new AgentService(pool),
    private readonly commands = new AgentCommandService(pool),
    private readonly events = new AgentEventService(pool),
  ) {}

  async detect(tenantId: string, text: string): Promise<PlatformPlan | null> {
    const mentioned = await this.agents.findByMention(tenantId, text);
    if (mentioned) {
      const alertQuestion = /(告警|故障|异常|健康|正常吗)/i.test(text);
      const analysisQuestion = /(检查|排查|原因|为什么|分析|诊断|处理|影响)/i.test(text);
      if (alertQuestion && !analysisQuestion) {
        return { kind: 'host-alerts', agent: mentioned, query: text };
      }
      return {
        kind: 'agent',
        agent: mentioned,
        query: text,
        mode: /(重新发现|刷新.{0,6}配置|发现配置)/i.test(text) ? 'discovery' : 'inspect',
      };
    }

    const inventory = /(纳管|托管|平台上|在线|离线)[^。！？\n]{0,24}(智能体|agent|主机|服务器)|(智能体|agent)[^。！？\n]{0,12}(多少|几台|哪些|列表|统计)|(多少|几台)[^。！？\n]{0,12}(智能体|agent)|(有哪些|列出|清单|列表|全部|所有|管理)[^。！？\n]{0,16}(智能体|agent|主机|服务器)/i.test(text);
    const hasAlertIntent = /(告警|故障|异常|事件)/i.test(text) && /(哪些|多少|列表|查看|当前|平台|有什么|上报)/i.test(text);
    if (hasAlertIntent) return { kind: 'alerts', query: text };
    if (!inventory) return null;
    const systems = await this.agents.listAppSystems(tenantId);
    const mentionedSystem = systems.find((system) => text.includes(system.name) || text.includes(system.code));
    return {
      kind: 'inventory',
      query: text,
      ...(mentionedSystem ? { appSystemId: mentionedSystem.id, appSystemName: mentionedSystem.name } : {}),
    };
  }

  async *execute(plan: PlatformPlan, tenantId: string, sessionId: string): AsyncIterable<RuntimeEvent> {
    if (plan.kind === 'host-alerts') {
      yield this.toolCall(sessionId, 'opsagent.agent_alerts', { hostname: plan.agent.hostname }, 'R0');
      const alerts = (await this.events.list(tenantId, plan.agent.id)).filter((event) => event.status === 'open');
      yield this.toolResult(sessionId, 'opsagent.agent_alerts', { hostname: plan.agent.hostname, count: alerts.length });
      if (alerts.length === 0) {
        yield this.assistant(sessionId, `**${plan.agent.hostname}** 当前没有待处理告警。Agent 最近一次自巡航未发现磁盘或内存异常。`);
      } else {
        const lines = [`**${plan.agent.hostname}** 当前有 **${alerts.length}** 条待处理告警：`];
        for (const event of alerts) {
          lines.push('', `### ${this.severityLabel(event.severity)} · ${event.title}`, event.detail, `发现时间：${relativeTime(event.detectedAt)}`);
        }
        lines.push('', '可以在「操作系统智能体」页打开该主机，在「告警」标签查看完整记录。');
        yield this.assistant(sessionId, lines.join('\n'));
      }
      yield this.done(sessionId);
      return;
    }

    if (plan.kind === 'alerts') {
      yield this.toolCall(sessionId, 'opsagent.alerts', { query: plan.query }, 'R0');
      const alerts = await this.events.openForTenant(tenantId);
      yield this.toolResult(sessionId, 'opsagent.alerts', {
        count: alerts.length,
        critical: alerts.filter((event) => event.severity === 'critical').length,
      });
      const lines = [`当前有 **${alerts.length}** 条智能体主动上报的待处理异常。`];
      if (alerts.length > 0) {
        lines.push('', '| 主机 | 级别 | 异常 | 详情 | 发现时间 |', '| --- | --- | --- | --- | --- |');
        for (const event of alerts.slice(0, 12)) {
          lines.push(`| ${event.hostname} | ${this.severityLabel(event.severity)} | ${event.title} | ${event.detail} | ${relativeTime(event.detectedAt)} |`);
        }
      } else {
        lines.push('', '当前没有待处理告警。');
      }
      yield this.assistant(sessionId, lines.join('\n'));
      yield this.done(sessionId);
      return;
    }

    if (plan.kind === 'inventory') {
      yield this.toolCall(sessionId, 'opsagent.fleet', {
        query: plan.query,
        ...(plan.appSystemId ? { appSystemId: plan.appSystemId } : {}),
      }, 'R0');
      const fleet = await this.agents.fleet(tenantId, {
        ...(plan.appSystemId ? { appSystemId: plan.appSystemId } : {}),
        pageSize: 100,
      });
      yield this.toolResult(sessionId, 'opsagent.fleet', {
        total: fleet.total,
        summary: fleet.summary,
        appSystem: plan.appSystemName ?? null,
      });
      yield this.assistant(sessionId, this.formatInventory(fleet, plan.appSystemName));
      yield this.done(sessionId);
      return;
    }

    if (plan.mode === 'discovery') {
      yield this.toolCall(sessionId, 'opsagent.agent_command', {
        hostname: plan.agent.hostname,
        type: 'discovery',
      }, 'R2');
      const command = await this.waitCommand(tenantId, plan.agent.id, 'discovery', {});
      const agent = (await this.agents.get(plan.agent.id, tenantId)) ?? plan.agent;
      const alerts = (await this.events.list(tenantId, agent.id)).filter((event) => event.status === 'open');
      yield this.toolResult(sessionId, 'opsagent.agent_command', {
        commandId: command?.id ?? null,
        type: 'discovery',
        status: command?.status ?? 'failed',
      });
      yield this.assistant(sessionId, this.formatConfig(agent, alerts, command ?? undefined));
      yield this.done(sessionId);
      return;
    }

    yield this.toolCall(sessionId, 'opsagent.agent_query', {
      hostname: plan.agent.hostname,
      question: plan.query,
    }, 'R1');
    const command = await this.waitCommand(tenantId, plan.agent.id, 'inspect', { question: plan.query });
    const alerts = (await this.events.list(tenantId, plan.agent.id)).filter((event) => event.status === 'open');
    yield this.toolResult(sessionId, 'opsagent.agent_query', {
      commandId: command?.id ?? null,
      type: 'inspect',
      status: command?.status ?? 'failed',
    });
    if (!command) {
      yield this.assistant(sessionId, `没有找到 **${plan.agent.hostname}** 对应的 Agent 命令通道。`);
    } else if (command.status !== 'completed') {
      yield this.assistant(sessionId, `已向 **${plan.agent.hostname}** 下发只读检查，当前状态为 **${command.status}**。Agent 会在下次心跳（约 10 秒）执行，完成后可在命令历史查看结果。`);
    } else {
      const result = typeof command.result === 'object' && command.result !== null
        ? command.result as Record<string, unknown>
        : {};
      const answer = typeof result.answer === 'string' ? result.answer : '';
      const lines = [answer || `## ${plan.agent.hostname} 检查结果`, ''];
      if (alerts.length > 0) {
        lines.push('### 当前告警', '');
        for (const event of alerts) lines.push(`- **${event.title}**：${event.detail}`);
      }
      yield this.assistant(sessionId, lines.join('\n'));
    }
    yield this.done(sessionId);
  }

  private async waitCommand(
    tenantId: string,
    agentId: string,
    type: string,
    input: Record<string, unknown>,
  ): Promise<AgentCommandRecord | null> {
    const created = await this.commands.create({ tenantId, agentId, type, input });
    if (!created) return null;
    let command = created;
    for (let attempt = 0; attempt < 20 && command.status !== 'completed'; attempt += 1) {
      await delay(1000);
      command = (await this.commands.get(tenantId, agentId, created.id)) ?? command;
    }
    return command;
  }

  private formatInventory(fleet: Awaited<ReturnType<AgentService['fleet']>>, appSystemName?: string): string {
    const lines: string[] = [];
    if (appSystemName) {
      lines.push(`应用系统 **${appSystemName}** 下当前纳管 **${fleet.total}** 台操作系统智能体。`);
    } else {
      lines.push(`当前平台纳管 **${fleet.summary.total}** 台操作系统智能体：**${fleet.summary.online}** 台在线，**${fleet.summary.offline}** 台离线。`);
    }
    lines.push(`已归属应用系统 **${fleet.summary.appSystems}** 个，已发现应用 **${fleet.summary.applications}** 个，完成配置发现 **${fleet.summary.discovered}/${fleet.summary.total}** 台。`);
    if (fleet.items.length > 0) {
      lines.push('', '| 主机 | 状态 | 应用系统 | 操作系统 | 应用数 |', '| --- | --- | --- | --- | --- |');
      for (const agent of fleet.items.slice(0, 12)) {
        lines.push(`| ${agent.hostname} | ${agent.status === 'online' ? '在线' : '离线'} | ${agent.appSystem?.name ?? '未归属'} | ${value(agent.systemInfo.osPretty || agent.systemInfo.osName || agent.os)} | ${agent.applications.length} |`);
      }
      if (fleet.total > 12) lines.push('', `还有 **${fleet.total - 12}** 台，可在「操作系统智能体」页面查看完整清单。`);
    }
    lines.push('', '可以直接问我某台主机的配置、磁盘分区、服务、端口、进程、日志、Agent 部署路径等。');
    return lines.join('\n');
  }

  private formatConfig(agent: AgentRecord, alerts: AgentEventRecord[], command?: AgentCommandRecord): string {
    if (!command) return `没有找到 **${agent.hostname}** 对应的 Agent。`;
    if (command.status !== 'completed') {
      return `已向 **${agent.hostname}** 下发配置发现命令，当前状态为 **${command.status}**。完成后可在命令历史查看结果。`;
    }
    const lines = [
      `## ${agent.hostname} 系统配置`,
      '',
      `- 操作系统：**${value(agent.systemInfo.osPretty || agent.systemInfo.osName || agent.os)}**`,
      `- 内核：**${value(agent.systemInfo.kernel)}**`,
      `- 主 IP：**${value(agent.systemInfo.ip)}**`,
      `- CPU / 内存：**${rounded(agent.systemInfo.cpuCores, 0)}C / ${rounded(agent.systemInfo.memoryTotalGB)}G**`,
      `- 磁盘：**${rounded(agent.systemInfo.diskFreeGB)}G 可用 / ${rounded(agent.systemInfo.diskTotalGB)}G**`,
      `- 时区：**${value(agent.systemInfo.timezone)}**`,
      `- Agent：**${value(agent.agentInfo.version || agent.version)}**，服务状态 **${value(agent.agentInfo.serviceStatus)}**`,
      `- Agent 安装路径：**${value(agent.agentInfo.installPath)}**`,
      `- Agent 根目录：**${value(agent.agentInfo.homePath)}**`,
      `- Agent 配置文件：**${value(agent.agentInfo.configPath)}**`,
      `- Agent 日志目录：**${value(agent.agentInfo.logPath)}**`,
      `- Agent 快照目录：**${value(agent.agentInfo.snapshotPath)}**`,
      `- Agent 工具目录：**${value(agent.agentInfo.toolsPath)}**`,
      `- Agent 服务：**${value(agent.agentInfo.serviceName)}**`,
    ];
    if (agent.applications.length > 0) {
      lines.push('', '### 应用部署', '', '| 应用 | 类型 | 状态 | 端口 |', '| --- | --- | --- | --- |');
      for (const app of agent.applications.slice(0, 12)) {
        lines.push(`| ${value(app.name)} | ${value(app.kind)} | ${value(app.status)} | ${value(app.ports)} |`);
      }
    } else {
      lines.push('', '未发现应用部署。');
    }
    if (alerts.length > 0) {
      lines.push('', '### 当前告警', '');
      for (const event of alerts) lines.push(`- **${event.title}**：${event.detail}`);
    }
    return lines.join('\n');
  }

  private severityLabel(severity: string): string {
    return severity === 'critical' ? '严重' : severity === 'warning' ? '警告' : '提示';
  }

  private toolCall(sessionId: string, tool: string, args: Record<string, unknown>, risk: 'R0' | 'R1' | 'R2'): RuntimeEvent {
    return { type: 'tool.call', sessionId, at: new Date().toISOString(), tool, args, risk };
  }

  private toolResult(sessionId: string, tool: string, result: unknown): RuntimeEvent {
    return { type: 'tool.result', sessionId, at: new Date().toISOString(), tool, result };
  }

  private assistant(sessionId: string, text: string): RuntimeEvent {
    return { type: 'assistant.delta', sessionId, at: new Date().toISOString(), text, source: 'platform' };
  }

  private done(sessionId: string): RuntimeEvent {
    return { type: 'session.done', sessionId, at: new Date().toISOString() };
  }
}
