import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from '../src/routes/agents.js';
import { listAgents } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listAgents: vi.fn(),
}));

const listMock = vi.mocked(listAgents);

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
      },
    ]);
    render(<Agents onBack={vi.fn()} />);
    expect((await screen.findAllByText('prod-host-1')).length).toBeGreaterThan(0);
    expect(screen.getByText('online')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Agents onBack={vi.fn()} />);
    expect(await screen.findByText('暂无 Agent')).toBeInTheDocument();
  });
});
