import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Messages } from '../src/routes/messages.js';
import { listMessages, markMessageRead } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listMessages: vi.fn(),
  markMessageRead: vi.fn(),
}));

const listMock = vi.mocked(listMessages);
const readMock = vi.mocked(markMessageRead);

describe('Messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists messages and marks one read', async () => {
    listMock.mockResolvedValue([
      {
        id: 'm-1',
        title: '巡检失败',
        body: 'Prometheus 不可达',
        severity: 'warning',
        readAt: null,
        createdAt: '2026-11-03T00:00:00.000Z',
      },
    ]);
    readMock.mockResolvedValue(undefined);
    render(<Messages onBack={vi.fn()} />);
    expect((await screen.findAllByText('巡检失败')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '标记已读' }));
    await waitFor(() => expect(readMock).toHaveBeenCalledWith('m-1'));
    expect(await screen.findByText('已读')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Messages onBack={vi.fn()} />);
    expect(await screen.findByText('暂无消息')).toBeInTheDocument();
  });
});
