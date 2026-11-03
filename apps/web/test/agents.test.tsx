import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from '../src/routes/agents.js';
import { createAgentCommand, listAgents } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listAgents: vi.fn(),
  createAgentCommand: vi.fn(),
  listAgentCommands: vi.fn(),
  getAgentInstallCommand: vi.fn().mockImplementation(async (os: string) => ({
    os,
    command: os === 'linux' ? 'curl install.sh | bash' : 'iwr install.ps1 | iex',
  })),
}));

const listMock = vi.mocked(listAgents);
const commandMock = vi.mocked(createAgentCommand);

describe('Agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists agents', async () => {
    listMock.mockResolvedValue([
      {
        id: 'a-1',
        name: 'prod-host-1',
        hostname: 'prod-host-1',
        os: 'linux',
        arch: 'amd64',
        version: '0.1.0',
        status: 'online',
        lastSeen: '2026-11-03T00:00:00.000Z',
        metrics: { cpuCores: 8 },
      },
    ]);
    render(<Agents onBack={vi.fn()} />);
    expect((await screen.findAllByText('prod-host-1')).length).toBeGreaterThan(0);
    expect(screen.getByText('online')).toBeInTheDocument();
    commandMock.mockResolvedValue({
      id: 'c-1',
      agentId: 'a-1',
      type: 'diagnostics',
      status: 'pending',
      result: null,
      createdAt: new Date().toISOString(),
    });
    fireEvent.click(screen.getByRole('button', { name: '执行诊断' }));
    expect(await screen.findByText(/诊断命令/)).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Agents onBack={vi.fn()} />);
    expect(await screen.findByText('暂无 Agent')).toBeInTheDocument();
  });
});
