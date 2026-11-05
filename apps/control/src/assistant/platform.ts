import type { RuntimeEvent } from '@opsagent/contracts';
import type { Pool } from 'pg';
import { AgentCommandService, type AgentCommandRecord } from '../agents/commands.js';
import type { AgentEventRecord } from '../agents/events.js';
import { AgentEventService } from '../agents/events.js';
import { AppHealthService } from '../agents/health.js';
import { AgentService, type AgentRecord } from '../agents/service.js';
import type { CompletionRequest } from '../models/completion.js';

export interface PlatformAnswerer {
  complete(input: CompletionRequest): Promise<string>;
}

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
    }
  | {
      readonly kind: 'exec';
      readonly agent: AgentRecord;
      readonly query: string;
      readonly argv: string[];
    }
  | {
      readonly kind: 'agent-batch';
      readonly targets: AgentRecord[];
      readonly instruction: string;
      readonly readOnly: boolean;
      readonly query: string;
    }
  | {
      readonly kind: 'app-health';
      readonly appSystemId: string;
      readonly appSystemName: string;
      readonly query: string;
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
    private readonly health = new AppHealthService(pool),
    private readonly answerer?: PlatformAnswerer,
  ) {}

  async detect(tenantId: string, text: string): Promise<PlatformPlan | null> {
    const batchPlan = await this.detectAgentBatch(tenantId, text);
    if (batchPlan) return batchPlan;
    const mentioned = await this.agents.findByMention(tenantId, text);
    if (mentioned) {
      const alertQuestion = /(告警|故障|异常|健康|正常吗)/i.test(text);
      const analysisQuestion = /(检查|排查|原因|为什么|分析|诊断|处理|影响)/i.test(text);
      if (alertQuestion && !analysisQuestion) {
        return { kind: 'host-alerts', agent: mentioned, query: text };
      }
      const pathMatch = text.match(/(?:^|\s)(\/[^\s，。！？；;:：]+)/);
      const path = pathMatch?.[1]?.replace(/[，。！？；;:：]+$/g, '');
      if (path && /(看看|查看|列出|目录|文件|日志|内容|权限|大小|读取|打开|tail|ls)/i.test(text)) {
        let argv: string[];
        const lineMatch = text.match(/(?:最后|末尾)\s*(\d{1,3})\s*行/);
        const lines = Math.min(Number.parseInt(lineMatch?.[1] ?? '100', 10) || 100, 500);
        if (path.endsWith('.log') || /tail|最后|末尾|日志内容|内容/i.test(text)) {
          argv = ['tail', '-n', String(lines), path];
        } else if (/(权限|属性|大小|stat)/i.test(text)) {
          argv = ['stat', path];
        } else {
          argv = ['ls', '-lah', path];
        }
        return { kind: 'exec', agent: mentioned, query: text, argv };
      }
      return {
        kind: 'agent',
        agent: mentioned,
        query: text,
        mode: /(重新发现|刷新.{0,6}配置|发现配置)/i.test(text) ? 'discovery' : 'inspect',
      };
    }

    const systems = await this.agents.listAppSystems(tenantId);
    const mentionedSystem = systems.find((system) => text.includes(system.name) || text.includes(system.code));
    if (mentionedSystem && /(健康|根因|故障|异常|影响范围)/.test(text)) {
      return {
        kind: 'app-health',
        appSystemId: mentionedSystem.id,
        appSystemName: mentionedSystem.name,
        query: text,
      };
    }

    const inventory = /(纳管|托管|平台上|在线|离线)[^。！？\n]{0,24}(智能体|agent|主机|服务器)|(智能体|agent)[^。！？\n]{0,12}(多少|几台|哪些|列表|统计)|(多少|几台)[^。！？\n]{0,12}(智能体|agent)|(有哪些|列出|清单|列表|全部|所有|管理)[^。！？\n]{0,16}(智能体|agent|主机|服务器)/i.test(text);
    const hasAlertIntent = /(告警|故障|异常|事件)/i.test(text) && /(哪些|多少|列表|查看|当前|平台|有什么|上报)/i.test(text);
    if (hasAlertIntent) return { kind: 'alerts', query: text };
    if (!inventory) return null;
    return {
      kind: 'inventory',
      query: text,
      ...(mentionedSystem ? { appSystemId: mentionedSystem.id, appSystemName: mentionedSystem.name } : {}),
    };
  }

  private async detectAgentBatch(tenantId: string, text: string): Promise<PlatformPlan | null> {
    const trimmed = text.trim();
    const startsAsCommand = /^(给|对|让|向|通知|批量给|批量对)\s*/i.test(trimmed);
    const batchAll = /(所有主机|全部主机|所有节点|全部节点|每台主机|批量执行|批量检查|批量巡检)/i.test(trimmed);
    const action = /(执行|运行|下发|发送指令|发送|检查|查看|排查|分析|巡检|采集|收集|查一下|看看)/i.test(trimmed);
    if (!action || (!startsAsCommand && !batchAll)) return null;

    let targets: AgentRecord[] = [];
    let label = '';
    let instruction = trimmed;
    const systems = await this.agents.listAppSystems(tenantId);
    const system = systems
      .filter((item) => item.name && trimmed.includes(item.name))
      .sort((left, right) => right.name.length - left.name.length)[0];
    if (system) {
      label = system.name;
      const all = await this.agents.list(tenantId);
      targets = all.filter((agent) => agent.appSystem?.id === system.id);
      instruction = instruction.replaceAll(system.name, ' ');
    } else if (batchAll) {
      label = '全部在线主机';
      const all = await this.agents.list(tenantId);
      targets = all.filter((agent) => agent.status === 'online');
    } else {
      const mentioned = await this.agents.findByMention(tenantId, trimmed);
      if (!mentioned) return null;
      label = mentioned.hostname;
      targets = [mentioned];
      instruction = instruction.replaceAll(mentioned.hostname, ' ');
      if (mentioned.name) instruction = instruction.replaceAll(mentioned.name, ' ');
    }
    targets = targets.filter((agent) => agent.status === 'online').slice(0, 20);
    if (targets.length === 0) return null;

    instruction = instruction
      .replace(/^(给|对|让|向|通知|批量给|批量对)\s*/i, '')
      .replace(/^(\s*(执行|运行|下发|发送指令|发送)\s*[:：]?\s*)/i, '')
      .replace(new RegExp(`\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), ' ')
      .replace(/^[，,。；;：:\s]+/, '')
      .trim();
    if (!instruction) instruction = '检查系统概况';
    return {
      kind: 'agent-batch',
      targets,
      instruction,
      readOnly: !/(重启|停止|启动|删除|修改|写入|安装|卸载|kill|restart|stop|start|rm\s|chmod|chown)/i.test(instruction),
      query: text,
    };
  }

  async *execute(plan: PlatformPlan, tenantId: string, sessionId: string, modelId?: string): AsyncIterable<RuntimeEvent> {
    if (plan.kind === 'agent-batch') {
      yield* this.executeAgentBatch(plan, tenantId, sessionId, modelId);
      return;
    }
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

    if (plan.kind === 'exec') {
      yield this.toolCall(sessionId, 'opsagent.exec', {
        hostname: plan.agent.hostname,
        argv: plan.argv,
      }, 'R1');
      const command = await this.waitCommand(tenantId, plan.agent.id, 'exec', { argv: plan.argv });
      const result = typeof command?.result === 'object' && command.result !== null
        ? command.result as Record<string, unknown>
        : {};
      yield this.toolResult(sessionId, 'opsagent.exec', {
        commandId: command?.id ?? null,
        status: command?.status ?? 'failed',
        exitCode: result.exitCode ?? null,
      });
      if (!command || command.status !== 'completed') {
        yield this.assistant(sessionId, `命令 **${plan.argv.join(' ')}** 已下发，当前状态为 **${command?.status ?? 'failed'}**。Agent 下次心跳后执行，可在命令历史查看结果。`);
        yield this.done(sessionId);
        return;
      }
      const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      const lines = [
        '## 命令执行结果',
        '',
        `\`$ ${plan.argv.join(' ')}\``,
        '',
      ];
      if (stdout) lines.push('```text', stdout, '```');
      if (stderr) lines.push('', '### stderr', '```text', stderr, '```');
      lines.push('', `退出码：**${String(result.exitCode ?? 'unknown')}**`);
      if (!stdout && !stderr) lines.push('', '命令执行完成，没有输出。');
      yield this.assistant(sessionId, lines.join('\n'));
      yield this.done(sessionId);
      return;
    }

    if (plan.kind === 'app-health') {
      yield this.toolCall(sessionId, 'opsagent.app_health', {
        appSystemId: plan.appSystemId,
        appSystemName: plan.appSystemName,
      }, 'R0');
      const checks = await this.health.latest(tenantId, plan.appSystemId);
      const check = checks[0];
      yield this.toolResult(sessionId, 'opsagent.app_health', {
        appSystemName: plan.appSystemName,
        found: Boolean(check),
        summary: check?.summary ?? null,
      });
      if (!check) {
        yield this.assistant(sessionId, `**${plan.appSystemName}** 还没有应用系统健康检查记录。节点异常上报后会自动触发全系统检查。`);
      } else {
        const lines = [
          `## ${check.appSystemName} 应用系统健康`,
          '',
          check.summary,
          '',
          `### 根因`,
          check.rootCause,
          '',
          '### 节点',
          '| 主机 | 状态 | 问题 | 日志信号 |',
          '| --- | --- | --- | --- |',
        ];
        for (const finding of check.findings) {
          const status = finding.status === 'critical' ? '严重' : finding.status === 'warning' ? '警告' : finding.status === 'offline' ? '离线' : '正常';
          lines.push(`| ${finding.hostname} | ${status} | ${finding.issues.join('；') || '—'} | ${finding.logSignals.join('；').slice(0, 200) || '—'} |`);
        }
        lines.push('', `检查时间：${relativeTime(check.createdAt)}`);
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
      const answer = await this.answerHostQuestion(plan.agent, plan.query, result, alerts, tenantId, modelId);
      yield this.assistant(sessionId, answer, 'model');
    }
    yield this.done(sessionId);
  }

  private async answerHostQuestion(
    agent: AgentRecord,
    question: string,
    result: Record<string, unknown>,
    alerts: AgentEventRecord[],
    tenantId: string,
    modelId?: string,
  ): Promise<string> {
    const evidence = typeof result.evidence === 'object' && result.evidence !== null
      ? result.evidence as Record<string, unknown>
      : {};
    if (this.answerer) {
      try {
        const context = JSON.stringify({
          hostname: agent.hostname,
          question,
          evidence,
          memory: typeof result.memory === 'string' ? result.memory : '',
          alerts: alerts.map((event) => ({ title: event.title, detail: event.detail, severity: event.severity })),
        }).slice(0, 16_000);
        const answer = await this.answerer.complete({
          tenantId,
          ...(modelId ? { modelId } : {}),
          system: [
            '你是 OpsAgent 主机智能体助手。',
            '只根据给定的主机检查证据回答用户问题。',
            '直接给结论，不要重复整段原始命令输出，不要编造证据中不存在的信息。',
            '如果证据不足，明确说明需要补充哪项检查。',
            '回答使用简体中文，控制在 300 字以内，除非用户要求详细展开。',
          ].join('\n'),
          prompt: context,
          maxTokens: 800,
        });
        if (answer.trim()) return answer.trim();
      } catch (error) {
        console.error('[platform] host answer failed', {
          hostname: agent.hostname,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.fallbackHostAnswer(agent.hostname, question, result);
  }

  private fallbackHostAnswer(hostname: string, question: string, result: Record<string, unknown>): string {
    const evidence = typeof result.evidence === 'object' && result.evidence !== null
      ? result.evidence as Record<string, unknown>
      : {};
    const analysis = typeof result.analysis === 'string' ? result.analysis.trim() : '';
    if (analysis) return analysis;
    const interfaces = typeof evidence.interfaces === 'string' ? evidence.interfaces : '';
    if (/(ip|地址|网卡|网络)/i.test(question) && interfaces) {
      const addresses = [...interfaces.matchAll(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/g)]
        .map((match) => match[1])
        .filter((address) => address && address !== '127.0.0.1');
      if (addresses.length > 0) {
        return `**${hostname}** 的 IPv4 地址是 **${addresses[0]}**。`;
      }
    }
    const raw = typeof result.answer === 'string' ? result.answer.trim() : '';
    return raw || `已完成 **${hostname}** 的只读检查，但没有取得可用结果。`;
  }

  private async *executeAgentBatch(
    plan: Extract<PlatformPlan, { kind: 'agent-batch' }>,
    tenantId: string,
    sessionId: string,
    modelId?: string,
  ): AsyncIterable<RuntimeEvent> {
    if (!plan.readOnly) {
      yield this.assistant(sessionId, '该指令包含写操作，已拒绝在普通对话中直接执行。请在「操作系统智能体 → 自然语言」中发起并走平台审批。');
      yield this.done(sessionId);
      return;
    }
    yield this.toolCall(sessionId, 'opsagent.agent_batch', {
      instruction: plan.instruction,
      targets: plan.targets.map((agent) => agent.hostname),
    }, 'R1');
    const results = await Promise.all(plan.targets.map(async (agent) => {
      const command = await this.commands.create({
        tenantId,
        agentId: agent.id,
        type: 'inspect',
        input: { question: plan.instruction },
      });
      if (!command) return { hostname: agent.hostname, status: 'failed', analysis: '', answer: '' };
      let current = command;
      for (let attempt = 0; attempt < 30 && !['completed', 'failed'].includes(current.status); attempt += 1) {
        await delay(1000);
        current = (await this.commands.get(tenantId, agent.id, command.id)) ?? current;
      }
      const payload = typeof current.result === 'object' && current.result !== null
        ? current.result as Record<string, unknown>
        : {};
      return {
        hostname: agent.hostname,
        status: current.status,
        analysis: typeof payload.analysis === 'string' ? payload.analysis : '',
        answer: typeof payload.answer === 'string' ? payload.answer : '',
      };
    }));
    yield this.toolResult(sessionId, 'opsagent.agent_batch', {
      instruction: plan.instruction,
      succeeded: results.filter((item) => item.status === 'completed').length,
      failed: results.filter((item) => item.status !== 'completed').length,
    });
    const answer = await this.summarizeBatch(plan.instruction, results, tenantId, modelId);
    yield this.assistant(sessionId, answer, 'model');
    yield this.done(sessionId);
  }

  private async summarizeBatch(
    instruction: string,
    results: Array<{ hostname: string; status: string; analysis: string; answer: string }>,
    tenantId: string,
    modelId?: string,
  ): Promise<string> {
    if (this.answerer && results.some((item) => item.analysis || item.answer)) {
      try {
        const answer = await this.answerer.complete({
          tenantId,
          ...(modelId ? { modelId } : {}),
          system: [
            '你是 OpsAgent 总控智能体。',
            '下面是多台操作系统智能体执行同一指令的结果。',
            '汇总成简洁结论：哪些节点成功、哪些失败、共性问题是什么、下一步建议是什么。',
            '不要逐台粘贴原始数据，使用简体中文，控制在 500 字以内。',
          ].join('\n'),
          prompt: JSON.stringify({ instruction, results }).slice(0, 20_000),
          maxTokens: 1000,
        });
        if (answer.trim()) return answer.trim();
      } catch (error) {
        console.error('[platform] batch summary failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const lines = [`**总控指令**：${instruction}`, ''];
    for (const item of results) {
      const detail = item.analysis || item.answer;
      lines.push(`- **${item.hostname}**：${item.status}${detail ? ` — ${(detail.split('\n')[0] ?? '').slice(0, 180)}` : ''}`);
    }
    return lines.join('\n');
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

  private assistant(sessionId: string, text: string, source: 'platform' | 'model' = 'platform'): RuntimeEvent {
    return { type: 'assistant.delta', sessionId, at: new Date().toISOString(), text, source };
  }

  private done(sessionId: string): RuntimeEvent {
    return { type: 'session.done', sessionId, at: new Date().toISOString() };
  }
}
