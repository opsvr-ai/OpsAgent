import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { RuntimeEvent } from '@opsagent/contracts';
import { PlatformAssistant } from '../src/assistant/platform.js';
import type { AgentService } from '../src/agents/service.js';
import type { AgentCommandService } from '../src/agents/commands.js';

const agent = {
  id: 'a-1',
  name: 'prod-web-01',
  hostname: 'prod-web-01',
  os: 'linux',
  arch: 'amd64',
  version: '0.2.0',
  status: 'online',
  lastSeen: new Date().toISOString(),
  metrics: { cpuCores: 8, memTotalGB: 16, memLoadPct: 44, diskFreeGB: 128, diskTotalGB: 200 },
  systemInfo: { osPretty: 'Rocky Linux 9.4', kernel: '5.14', ip: '10.0.0.1', cpuCores: 8, memoryTotalGB: 16 },
  applications: [{ name: 'order-service', kind: 'systemd', status: 'running', ports: [8080] }],
  agentInfo: { version: '0.2.0', serviceStatus: 'running' },
  tags: ['prod'],
  discoveryAt: new Date().toISOString(),
  appSystem: null,
};

function fakes(answerer?: { complete: (input: { tenantId: string; modelId?: string; system: string; prompt: string; maxTokens?: number }) => Promise<string> }) {
  const agents = {
    findByMention: vi.fn().mockResolvedValue(null),
    listAppSystems: vi.fn().mockResolvedValue([]),
    fleet: vi.fn(),
    get: vi.fn().mockResolvedValue(agent),
  };
  const commands = {
    create: vi.fn(),
    get: vi.fn(),
  };
  const events = {
    list: vi.fn().mockResolvedValue([]),
    openForTenant: vi.fn().mockResolvedValue([]),
  };
  const health = {
    latest: vi.fn().mockResolvedValue([]),
  };
  const assistant = new PlatformAssistant(
    {} as Pool,
    agents as unknown as AgentService,
    commands as unknown as AgentCommandService,
    events as unknown as import('../src/agents/events.js').AgentEventService,
    health as unknown as import('../src/agents/health.js').AppHealthService,
    answerer,
  );
  return { assistant, agents, commands, events, health };
}

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('PlatformAssistant', () => {
  it('uses the selected platform model to answer host evidence concisely', async () => {
    const answerer = { complete: vi.fn().mockResolvedValue('prod-web-01 的 IPv4 地址是 7.24.4.68。') };
    const { assistant, agents, commands } = fakes(answerer);
    agents.findByMention.mockResolvedValue(agent);
    commands.create.mockResolvedValue({
      id: 'c-ip',
      agentId: 'a-1',
      type: 'inspect',
      status: 'completed',
      input: {},
      result: {
        answer: '## 主机检查结果\n大量原始内容',
        evidence: { interfaces: 'inet 7.24.4.68/24 brd 7.24.4.255 scope global ens192' },
      },
      createdAt: new Date().toISOString(),
    });
    const plan = await assistant.detect('tenant', '给我查 prod-web-01 的 IP 是多少');
    const events = await collect(assistant.execute(plan!, 'tenant', 'session-1', 'model-1'));
    const answer = events.find((event) => event.type === 'assistant.delta' && event.source === 'model');
    expect(answer).toMatchObject({ text: 'prod-web-01 的 IPv4 地址是 7.24.4.68。' });
    expect(answerer.complete).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant',
      modelId: 'model-1',
    }));
  });

  it('falls back to a concise IP answer without a model', async () => {
    const { assistant, agents, commands } = fakes();
    agents.findByMention.mockResolvedValue(agent);
    commands.create.mockResolvedValue({
      id: 'c-ip-2',
      agentId: 'a-1',
      type: 'inspect',
      status: 'completed',
      input: {},
      result: {
        answer: '## 主机检查结果\n大量原始内容',
        evidence: { interfaces: 'inet 7.24.4.68/24 brd 7.24.4.255 scope global ens192' },
      },
      createdAt: new Date().toISOString(),
    });
    const plan = await assistant.detect('tenant', '给我查 prod-web-01 的 IP 是多少');
    const events = await collect(assistant.execute(plan!, 'tenant', 'session-1'));
    expect(events.some((event) => event.type === 'assistant.delta' && event.text.includes('7.24.4.68'))).toBe(true);
  });

  it('answers managed-agent inventory from platform data', async () => {
    const { assistant, agents, commands } = fakes();
    agents.fleet.mockResolvedValue({
      items: [agent],
      total: 2,
      page: 1,
      pageSize: 100,
      summary: { total: 2, online: 1, offline: 1, appSystems: 1, applications: 3, discovered: 2 },
      appSystems: [],
    });
    const plan = await assistant.detect('tenant', '当前纳管了多少操作系统智能体？');
    expect(plan).toMatchObject({ kind: 'inventory' });
    const events = await collect(assistant.execute(plan!, 'tenant', 'session-1'));
    expect(events[0]).toMatchObject({ type: 'tool.call', tool: 'opsagent.fleet' });
    expect(events.some((event) => event.type === 'assistant.delta' && event.text.includes('当前平台纳管 **2** 台'))).toBe(true);
    expect(commands.create).not.toHaveBeenCalled();
  });

  it('routes arbitrary host questions to the agent inspect command', async () => {
    const { assistant, agents, commands } = fakes();
    agents.findByMention.mockResolvedValue(agent);
    commands.create.mockResolvedValue({
      id: 'c-1',
      agentId: 'a-1',
      type: 'inspect',
      status: 'completed',
      input: {},
      result: { answer: '## prod-web-01 磁盘分区\n已执行只读检查，磁盘分区如下。' },
      createdAt: new Date().toISOString(),
    });
    const plan = await assistant.detect('tenant', '查询 prod-web-01 的磁盘分区');
    expect(plan).toMatchObject({ kind: 'agent', mode: 'inspect' });
    const events = await collect(assistant.execute(plan!, 'tenant', 'session-1'));
    expect(events[0]).toMatchObject({ type: 'tool.call', tool: 'opsagent.agent_query' });
    expect(events.some((event) => event.type === 'assistant.delta' && event.text.includes('磁盘分区'))).toBe(true);
    expect(commands.create).toHaveBeenCalledWith({
      tenantId: 'tenant',
      agentId: 'a-1',
      type: 'inspect',
      input: { question: '查询 prod-web-01 的磁盘分区' },
    });
  });

  it('routes path questions to a read-only exec command', async () => {
    const { assistant, agents } = fakes();
    agents.findByMention.mockResolvedValue(agent);
    const plan = await assistant.detect('tenant', '看看 /opt/opsagent/logs 目录下有什么文件');
    expect(plan).toMatchObject({
      kind: 'exec',
      argv: ['ls', '-lah', '/opt/opsagent/logs'],
    });
  });

  it('answers app system health and root cause questions', async () => {
    const { assistant, agents, health } = fakes();
    agents.findByMention.mockResolvedValue(null);
    agents.listAppSystems.mockResolvedValue([{
      id: 's-1',
      code: 'order-center',
      name: '订单中心',
      owner: '交易研发组',
      criticality: 'P1',
      agentCount: 3,
      onlineCount: 3,
    }]);
    health.latest.mockResolvedValue([{
      id: 'h-1',
      appSystemId: 's-1',
      appSystemName: '订单中心',
      status: 'completed',
      summary: '应用系统 订单中心 检查 3 个节点，1 个异常。',
      rootCause: 'prod-web-01：磁盘可用空间不足',
      findings: [{
        agentId: 'a-1', hostname: 'prod-web-01', status: 'warning',
        issues: ['磁盘可用空间不足'], metrics: {}, applications: [], events: [], logSignals: ['order-service.log: ERROR No space left on device'],
      }],
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }]);
    const plan = await assistant.detect('tenant', '订单中心健康情况和故障根因是什么？');
    expect(plan).toMatchObject({ kind: 'app-health', appSystemName: '订单中心' });
    const emitted = await collect(assistant.execute(plan!, 'tenant', 'session-1'));
    expect(emitted[0]).toMatchObject({ type: 'tool.call', tool: 'opsagent.app_health' });
    expect(emitted.some((event) => event.type === 'assistant.delta' && event.text.includes('根因') && event.text.includes('磁盘可用空间不足'))).toBe(true);
  });

  it('answers host-specific alert questions directly', async () => {
    const { assistant, agents, events } = fakes();
    agents.findByMention.mockResolvedValue(agent);
    events.list.mockResolvedValue([{
      id: 'e-2',
      agentId: 'a-1',
      fingerprint: 'disk-low',
      severity: 'warning',
      title: '磁盘可用空间不足',
      detail: '根分区可用 8%',
      metric: {},
      status: 'open',
      detectedAt: new Date().toISOString(),
      resolvedAt: null,
    }]);
    const plan = await assistant.detect('tenant', 'opsagent-os-agent 上有告警吗？');
    expect(plan).toMatchObject({ kind: 'host-alerts' });
    const emitted = await collect(assistant.execute(plan!, 'tenant', 'session-1'));
    expect(emitted[0]).toMatchObject({ type: 'tool.call', tool: 'opsagent.agent_alerts' });
    expect(emitted.some((event) => event.type === 'assistant.delta' && event.text.includes('磁盘可用空间不足'))).toBe(true);
  });

  it('lists agent self-patrol alerts', async () => {
    const { assistant, agents, events } = fakes();
    agents.findByMention.mockResolvedValue(null);
    events.openForTenant.mockResolvedValue([{
      id: 'e-1',
      agentId: 'a-1',
      hostname: 'prod-web-01',
      fingerprint: 'disk-low',
      severity: 'warning',
      title: '磁盘可用空间不足',
      detail: '根分区可用 8%',
      metric: {},
      status: 'open',
      detectedAt: new Date().toISOString(),
      resolvedAt: null,
    }]);
    const plan = await assistant.detect('tenant', '当前有哪些告警？');
    expect(plan).toMatchObject({ kind: 'alerts' });
    const emitted = await collect(assistant.execute(plan!, 'tenant', 'session-1'));
    expect(emitted[0]).toMatchObject({ type: 'tool.call', tool: 'opsagent.alerts' });
    expect(emitted.some((event) => event.type === 'assistant.delta' && event.text.includes('磁盘可用空间不足'))).toBe(true);
  });
});
