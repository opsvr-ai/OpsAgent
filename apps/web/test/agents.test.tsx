import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from '../src/routes/agents.js';
import { createAgentCommand, getAgentDetail, getAgentFleet } from '../src/api/client.js';

const agent = {
  id: 'a-1',
  name: 'prod-host-1',
  hostname: 'prod-host-1',
  os: 'linux',
  arch: 'amd64',
  version: '0.2.0',
  status: 'online',
  lastSeen: '2026-11-03T00:00:00.000Z',
  metrics: { cpuCores: 8 },
  systemInfo: { osName: 'Rocky Linux', osVersion: '9.4', kernel: '5.14', ip: '10.0.0.1', cpuCores: 8, memoryTotalGB: 16 },
  applications: [{ name: 'order-service', kind: 'systemd', status: 'running' }],
  agentInfo: { version: '0.2.0', serviceStatus: 'running' },
  tags: ['prod'],
  discoveryAt: '2026-11-03T00:00:00.000Z',
  appSystem: null,
};

const fleet = {
  items: [agent],
  total: 1,
  page: 1,
  pageSize: 20,
  summary: { total: 1, online: 1, offline: 0, appSystems: 0, applications: 1, discovered: 1 },
  appSystems: [],
};

vi.mock('../src/api/client.js', () => ({
  getAgentFleet: vi.fn(),
  getAgentDetail: vi.fn(),
  assignAgentAppSystem: vi.fn(),
  createAgentCommand: vi.fn(),
  listAgentCommands: vi.fn().mockResolvedValue([]),
  getAgentInstallCommand: vi.fn().mockImplementation(async (os: string) => ({
    os,
    command: os === 'linux' ? 'curl install.sh | bash' : 'iwr install.ps1 | iex',
  })),
}));

const fleetMock = vi.mocked(getAgentFleet);
const detailMock = vi.mocked(getAgentDetail);
const commandMock = vi.mocked(createAgentCommand);

describe('Agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fleetMock.mockResolvedValue(fleet);
    detailMock.mockResolvedValue(agent);
    commandMock.mockResolvedValue({
      id: 'c-1',
      agentId: 'a-1',
      type: 'diagnostics',
      status: 'pending',
      result: null,
      createdAt: new Date().toISOString(),
    });
  });

  it('lists agents in the fleet table and opens details', async () => {
    render(<Agents onBack={vi.fn()} />);
    expect((await screen.findAllByText('prod-host-1')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('在线').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(await screen.findByRole('heading', { name: 'prod-host-1' })).toBeInTheDocument();
    expect(screen.getByText('系统配置')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '执行诊断' }));
    expect(commandMock).toHaveBeenCalledWith('a-1', 'diagnostics');
  });

  it('shows an empty state', async () => {
    fleetMock.mockResolvedValue({ ...fleet, items: [], total: 0 });
    render(<Agents onBack={vi.fn()} />);
    expect(await screen.findByText('没有匹配的主机')).toBeInTheDocument();
  });
});
