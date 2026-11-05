import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from '../src/routes/agents.js';
import {
  createAgentCommand,
  createAgentInstruction,
  getAgentDetail,
  getAgentFleet,
  getAgentInstruction,
} from '../src/api/client.js';

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
  alerts: [],
};

vi.mock('../src/api/client.js', () => ({
  getAgentFleet: vi.fn(),
  getAgentDetail: vi.fn(),
  getAgentInventory: vi.fn().mockResolvedValue([]),
  updateAgentInventory: vi.fn(),
  getAgentPatrolPolicy: vi.fn().mockResolvedValue({
    agentId: 'a-1',
    enabled: true,
    intervalSeconds: 30,
    diskFreePct: 15,
    memLoadPct: 85,
    load1: 0,
    updatedAt: null,
  }),
  updateAgentPatrolPolicy: vi.fn(),
  getAgentEvents: vi.fn().mockResolvedValue([]),
  getAppSystemHealth: vi.fn().mockResolvedValue([]),
  getCommandKeyStatus: vi.fn().mockResolvedValue({ keys: [], agents: [] }),
  assignAgentAppSystem: vi.fn(),
  createAgentCommand: vi.fn(),
  createAgentInstruction: vi.fn(),
  getAgentInstruction: vi.fn(),
  listAgentInstructions: vi.fn().mockResolvedValue([]),
  listAgentInstructionTemplates: vi.fn().mockResolvedValue([]),
  createAgentInstructionTemplate: vi.fn(),
  deleteAgentInstructionTemplate: vi.fn(),
  updateAgentInstructionTemplate: vi.fn(),
  listAgentCommands: vi.fn().mockResolvedValue([]),
  getAgentInstallCommand: vi.fn().mockImplementation(async (os: string) => ({
    os,
    command: os === 'linux' ? 'curl install.sh | bash' : 'iwr install.ps1 | iex',
  })),
}));

const fleetMock = vi.mocked(getAgentFleet);
const detailMock = vi.mocked(getAgentDetail);
const commandMock = vi.mocked(createAgentCommand);
const instructionMock = vi.mocked(createAgentInstruction);
const instructionDetailMock = vi.mocked(getAgentInstruction);

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

  it('sends a natural language instruction to the selected agent', async () => {
    instructionMock.mockResolvedValue({
      instructionId: 'i-1',
      commandId: 'i-1',
      agentId: 'a-1',
      hostname: 'prod-host-1',
      status: 'pending',
      intent: { kind: 'inspect', readOnly: true, confidence: 0.9 },
    });
    instructionDetailMock.mockResolvedValue({
      instructionId: 'i-1',
      commandId: 'i-1',
      status: 'completed',
      instruction: '系统运行多久了',
      intent: { kind: 'inspect', readOnly: true, confidence: 0.9 },
      answer: '系统运行时长：2 小时',
      evidence: { uptime: '2h' },
      toolsUsed: ['inspect'],
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    render(<Agents onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '详情' }));
    fireEvent.click(await screen.findByRole('button', { name: '自然语言' }));
    fireEvent.change(screen.getByLabelText('指令内容'), { target: { value: '系统运行多久了' } });
    fireEvent.click(screen.getByRole('button', { name: '下发指令' }));
    await waitFor(() => {
      expect(instructionMock).toHaveBeenCalledWith('a-1', '系统运行多久了', expect.any(String));
    });
    expect(await screen.findByText('系统运行时长：2 小时', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    fleetMock.mockResolvedValue({ ...fleet, items: [], total: 0 });
    render(<Agents onBack={vi.fn()} />);
    expect(await screen.findByText('没有匹配的主机')).toBeInTheDocument();
  });
});
