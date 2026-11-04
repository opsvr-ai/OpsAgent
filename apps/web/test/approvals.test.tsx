import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Approvals } from '../src/routes/approvals.js';
import { decideApproval, listApprovals } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
  listAgentInstructionApprovals: vi.fn().mockResolvedValue([]),
  decideAgentInstructionApproval: vi.fn(),
  decideAgentInstructionApprovals: vi.fn(),
  cancelAgentInstructionApproval: vi.fn(),
  listApprovalWebhookDeliveries: vi.fn().mockResolvedValue([]),
  listApprovalSideEffectFailures: vi.fn().mockResolvedValue([]),
  listOperationsAlertDeliveries: vi.fn().mockResolvedValue([]),
  replayOperationsAlertDelivery: vi.fn(),
  resolveApprovalSideEffectFailure: vi.fn(),
  replayApprovalWebhookDelivery: vi.fn(),
}));

const listMock = vi.mocked(listApprovals);
const decideMock = vi.mocked(decideApproval);

describe('Approvals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists pending approvals and approves one', async () => {
    listMock.mockResolvedValue([
      {
        id: 'a-1',
        action: 'write',
        risk: 'R2',
        sessionId: 's-1',
        details: { file_path: 'hello.txt' },
        createdAt: '2026-11-03T00:00:00.000Z',
      },
    ]);
    decideMock.mockResolvedValue(undefined);
    render(<Approvals onBack={vi.fn()} />);
    expect(await screen.findByText('write')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith('a-1', 'approve'));
    expect(await screen.findByText('暂无待审批')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Approvals onBack={vi.fn()} />);
    expect(await screen.findByText('暂无待审批')).toBeInTheDocument();
  });
});
