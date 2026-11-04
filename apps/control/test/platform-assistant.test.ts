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

function fakes() {
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
  const assistant = new PlatformAssistant(
    {} as Pool,
    agents as unknown as AgentService,
    commands as unknown as AgentCommandService,
    events as unknown as import('../src/agents/events.js').AgentEventService,
  );
  return { assistant, agents, commands, events };
}

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('PlatformAssistant', () => {
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

  it('answers host configuration from the latest discovery snapshot', async () => {
    const { assistant, agents, commands } = fakes();
    agents.findByMention.mockResolvedValue(agent);
    const plan = await assistant.detect('tenant', '检查 prod-web-01 的系统配置');
    expect(plan).toMatchObject({ kind: 'agent', commandType: 'discovery', refresh: false });
    const events = await collect(assistant.execute(plan!, 'tenant', 'session-1'));
    expect(events[0]).toMatchObject({ type: 'tool.call', tool: 'opsagent.agent_snapshot' });
    expect(events.some((event) => event.type === 'assistant.delta' && event.text.includes('prod-web-01 系统配置'))).toBe(true);
    expect(commands.create).not.toHaveBeenCalled();
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
