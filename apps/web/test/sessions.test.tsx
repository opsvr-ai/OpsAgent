import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sessions } from '../src/routes/sessions.js';
import { listSessions } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listSessions: vi.fn(),
}));

const listMock = vi.mocked(listSessions);

describe('Sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists sessions', async () => {
    listMock.mockResolvedValue([
      {
        id: 'session-1234567890',
        title: '检查订单服务',
        roleView: 'tenant_admin',
        status: 'active',
        createdAt: '2026-11-03T00:00:00.000Z',
        lastActivityAt: '2026-11-03T00:00:00.000Z',
        messageCount: 4,
      },
    ]);
    render(<Sessions onBack={vi.fn()} onOpenSession={vi.fn()} />);
    expect(await screen.findByText('检查订单服务')).toBeInTheDocument();
    expect(screen.getAllByText('tenant_admin').length).toBeGreaterThan(0);
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Sessions onBack={vi.fn()} onOpenSession={vi.fn()} />);
    expect(await screen.findByText('暂无会话')).toBeInTheDocument();
  });
});
