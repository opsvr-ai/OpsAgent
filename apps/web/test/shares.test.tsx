import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Shares } from '../src/routes/shares.js';
import { listShares, reviewShare } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listShares: vi.fn(),
  reviewShare: vi.fn(),
}));

const listMock = vi.mocked(listShares);
const reviewMock = vi.mocked(reviewShare);

describe('Shares', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists pending shares and approves one', async () => {
    listMock.mockResolvedValue([
      {
        id: 'sh-1',
        scenarioId: 's-1',
        scope: 'tenant',
        status: 'pending',
        requestedBy: 'u-1',
        reviewerId: null,
        reason: null,
      },
    ]);
    reviewMock.mockResolvedValue({
      id: 'sh-1',
      scenarioId: 's-1',
      scope: 'tenant',
      status: 'approved',
      requestedBy: 'u-1',
      reviewerId: 'u-2',
      reason: null,
    });

    render(<Shares onBack={vi.fn()} />);
    expect((await screen.findAllByText('s-1')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(reviewMock).toHaveBeenCalledWith('sh-1', 'approve'));
    expect((await screen.findAllByText(/approved/)).length).toBeGreaterThan(0);
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Shares onBack={vi.fn()} />);
    expect(await screen.findByText('暂无共享申请')).toBeInTheDocument();
  });
});
