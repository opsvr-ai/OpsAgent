import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Studio } from '../src/routes/studio.js';
import { listStudioSessions, submitStudioSession } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listStudioSessions: vi.fn(),
  createStudioSession: vi.fn(),
  submitStudioSession: vi.fn(),
  reviewStudioSession: vi.fn(),
}));

const listMock = vi.mocked(listStudioSessions);
const submitMock = vi.mocked(submitStudioSession);

describe('Studio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists sessions and submits a generated one', async () => {
    listMock.mockResolvedValue([
      {
        id: 'st-1',
        goal: 'connect cmdb',
        platform: 'blueking',
        status: 'generated',
        bundle: { goal: 'connect cmdb', files: [], manifest: {} },
      },
    ]);
    submitMock.mockResolvedValue({
      id: 'st-1',
      goal: 'connect cmdb',
      platform: 'blueking',
      status: 'pending_review',
      bundle: { goal: 'connect cmdb', files: [], manifest: {} },
    });

    render(<Studio onBack={vi.fn()} />);
    expect((await screen.findAllByText('connect cmdb')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    await waitFor(() => expect(submitMock).toHaveBeenCalledWith('st-1'));
    expect((await screen.findAllByText(/pending_review/)).length).toBeGreaterThan(0);
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Studio onBack={vi.fn()} />);
    expect(await screen.findByText('暂无创造会话')).toBeInTheDocument();
  });
});
