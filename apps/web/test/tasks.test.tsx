import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Tasks } from '../src/routes/tasks.js';
import { approveTask, listTasks } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  approveTask: vi.fn(),
}));

const listMock = vi.mocked(listTasks);
const approveMock = vi.mocked(approveTask);

describe('Tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists tasks and approves an awaiting task', async () => {
    listMock.mockResolvedValue([
      {
        id: 't-1',
        title: '后台巡检',
        scenarioId: 's-1',
        status: 'awaiting_approval',
        runId: 'r-1',
        error: null,
      },
    ]);
    approveMock.mockResolvedValue({
      id: 't-1',
      title: '后台巡检',
      scenarioId: 's-1',
      status: 'success',
      runId: 'r-1',
      error: null,
    });
    render(<Tasks onBack={vi.fn()} />);
    expect(await screen.findByText('后台巡检')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('t-1', 'approve'));
    expect(await screen.findByText('success')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Tasks onBack={vi.fn()} />);
    expect(await screen.findByText('暂无长任务')).toBeInTheDocument();
  });
});
