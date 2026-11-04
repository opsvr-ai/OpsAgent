import type { RuntimeEvent } from '@opsagent/contracts';
import type { Pool } from 'pg';
import { AgentCommandService, type AgentCommandRecord } from '../agents/commands.js';
import { AgentEventService } from '../agents/events.js';
import type { AgentEventRecord } from '../agents/events.js';
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
      readonly commandType: 'discovery' | 'diagnostics';
      readonly refresh: boolean;
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

function relativeTime(value: string | null): string {
  if (!value) return '未知';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
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
    if (mentioned && /(告警|故障|异常|健康|正常吗)/i.test(text) && !/(检查|排查|原因|为什么|分析|诊断|处理|影响)/i.test(text)) {
      return { kind: 'host-alerts', agent: mentioned, query: text };
    }
    if (mentioned && /(检查|查看|看看|查询|获取|诊断|巡检|配置|系统|内核|部署|应用|端口|路径|性能|指标|负载|cpu|内存|磁盘|状态|agent)/i.test(text)) {
      const wantsConfig = /(配置|系统信息|系统配置|内核|部署|应用|端口|发现)/i.test(text)
        && !/(性能|指标|负载|cpu|内存|磁盘|诊断|使用率|水位)/i.test(text);
      return {
        kind: 'agent',
        agent: mentioned,
        query: text,
        commandType: wantsConfig ? 'discovery' : 'diagnostics',
        refresh: !/(最近|上次|快照|历史|已上报)/i.test(text),
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
      yield this.toolResult(sessionId, 'opsagent.agent_alerts', {
        hostname: plan.agent.hostname,
        count: alerts.length,
      });
      if (alerts.length === 0) {
        yield this.assistant(sessionId, `**${plan.agent.hostname}** 当前没有待处理告警。Agent 最近一次自巡航未发现磁盘或内存异常。`);
      } else {
        const lines = [`**${plan.agent.hostname}** 当前有 **${alerts.length}** 条待处理告警：`];
        for (const event of alerts) {
          lines.push('', `### ${event.severity === 'critical' ? '严重' : event.severity === 'warning' ? '警告' : '提示'} · ${event.title}`, event.detail, `发现时间：${relativeTime(event.detectedAt)}`);
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
          lines.push(`| ${event.hostname} | ${event.severity === 'critical' ? '严重' : event.severity === 'warning' ? '警告' : '信息'} | ${event.title} | ${event.detail} | ${relativeTime(event.detectedAt)} |`);
        }
        lines.push('', '可以在「操作系统智能体」页点击对应主机查看自巡航告警详情。');
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

    const commandRisk = plan.commandType === 'discovery' ? 'R2' : 'R1';
    const hasSnapshot = plan.commandType === 'discovery'
      ? Boolean(plan.agent.discoveryAt)
      : Object.keys(plan.agent.metrics).length > 0;
    if (!plan.refresh && hasSnapshot) {
      const hostAlerts = await this.events.list(tenantId, plan.agent.id);
      yield this.toolCall(sessionId, 'opsagent.agent_snapshot', {
        hostname: plan.agent.hostname,
        type: plan.commandType,
      }, 'R0');
      yield this.toolResult(sessionId, 'opsagent.agent_snapshot', {
        hostname: plan.agent.hostname,
        discoveryAt: plan.agent.discoveryAt,
        applications: plan.agent.applications.length,
        metrics: plan.agent.metrics,
      });
      yield this.assistant(sessionId, this.formatAgent(plan.agent, plan.commandType, undefined, hostAlerts));
      yield this.done(sessionId);
      return;
    }

    yield this.toolCall(sessionId, 'opsagent.agent_command', {
      hostname: plan.agent.hostname,
      type: plan.commandType,
    }, commandRisk);
    const created = await this.commands.create({
      tenantId,
      agentId: plan.agent.id,
      type: plan.commandType,
    });
    if (!created) {
      yield this.toolResult(sessionId, 'opsagent.agent_command', { error: 'agent_not_found' });
      yield this.assistant(sessionId, '没有找到这台主机，命令未下发。');
      yield this.done(sessionId);
      return;
    }
    let command: AgentCommandRecord = created;
    for (let attempt = 0; attempt < 15 && command.status !== 'completed'; attempt += 1) {
      await delay(1000);
      command = (await this.commands.get(tenantId, plan.agent.id, created.id)) ?? command;
    }
    const agent = (await this.agents.get(plan.agent.id, tenantId)) ?? plan.agent;
    const hostAlerts = await this.events.list(tenantId, plan.agent.id);
    yield this.toolResult(sessionId, 'opsagent.agent_command', {
      commandId: command.id,
      type: command.type,
      status: command.status,
      result: command.result,
    });
    yield this.assistant(sessionId, this.formatAgent(agent, plan.commandType, command, hostAlerts));
    yield this.done(sessionId);
  }

  private formatInventory(
    fleet: Awaited<ReturnType<AgentService['fleet']>>,
    appSystemName?: string,
  ): string {
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
    lines.push('', '可以继续问：「检查 prod-web-01 的系统配置」或「查询 prod-order-12 的性能指标」。');
    return lines.join('\n');
  }

  private formatAgent(agent: AgentRecord, type: 'discovery' | 'diagnostics', command?: AgentCommandRecord, alerts?: AgentEventRecord[]): string {
    if (command && command.status !== 'completed') {
      return `已向 **${agent.hostname}** 下发${type === 'discovery' ? '配置发现' : '性能诊断'}命令，当前状态为 **${command.status}**。Agent 会在下次心跳（约 10 秒）后执行，完成后可在主机详情或命令历史查看结果。`;
    }
    if (type === 'diagnostics') {
      const commandResult = command?.result;
      const result = typeof commandResult === 'object' && commandResult !== null
        ? commandResult as Record<string, unknown>
        : {};
      const metrics = typeof result.metrics === 'object' && result.metrics !== null
        ? result.metrics as Record<string, unknown>
        : command ? result : agent.metrics;
      const lines = [
        `## ${agent.hostname} 性能指标`,
        '',
        `- CPU 核数：**${rounded(metrics.cpuCores ?? agent.systemInfo.cpuCores, 0)}**`,
        `- 内存总量：**${rounded(metrics.memTotalGB ?? agent.systemInfo.memoryTotalGB)} GB**`,
        `- 可用内存：**${rounded(metrics.memAvailableGB)} GB**`,
        `- 内存负载：**${rounded(metrics.memLoadPct)}%**`,
        `- 磁盘总量：**${rounded(metrics.diskTotalGB ?? agent.systemInfo.diskTotalGB)} GB**`,
        `- 磁盘可用：**${rounded(metrics.diskFreeGB ?? agent.systemInfo.diskFreeGB)} GB**`,
        `- Agent 堆内存：**${rounded(metrics.heapMB)} MB**`,
        `- 数据来源：${command ? '刚刚执行的性能诊断' : '最近一次心跳上报'}（${relativeTime(agent.lastSeen)}）`,
      ];
      const openAlerts = alerts?.filter((event) => event.status === 'open') ?? [];
      if (openAlerts.length > 0) {
        lines.push('', '### 当前告警', '');
        for (const event of openAlerts) lines.push(`- **${event.title}**：${event.detail}`);
      }
      lines.push('', `如需重新采集，可以说「重新诊断 ${agent.hostname} 的性能」。`);
      return lines.join('\n');
    }
    const applications = agent.applications;
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
      `- Agent 配置文件：**${value(agent.agentInfo.configPath)}**`,
      `- Agent 服务：**${value(agent.agentInfo.serviceName)}**`,
      `- 数据来源：${command ? '刚刚执行的配置发现' : '最近一次配置发现'}${agent.discoveryAt ? `（${relativeTime(agent.discoveryAt)}）` : ''}`,
    ];
    if (applications.length > 0) {
      lines.push('', '### 应用部署', '', '| 应用 | 类型 | 状态 | 端口 |', '| --- | --- | --- | --- |');
      for (const app of applications.slice(0, 12)) {
        lines.push(`| ${value(app.name)} | ${value(app.kind)} | ${value(app.status)} | ${value(app.ports)} |`);
      }
    } else {
      lines.push('', '未发现应用部署。');
    }
    const openAlerts = alerts?.filter((event) => event.status === 'open') ?? [];
    if (openAlerts.length > 0) {
      lines.push('', '### 当前告警', '');
      for (const event of openAlerts) lines.push(`- **${event.title}**：${event.detail}`);
    }
    lines.push('', `如需重新扫描，可以说「重新发现 ${agent.hostname} 的配置」。`);
    return lines.join('\n');
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
