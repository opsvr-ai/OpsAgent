import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Incidents } from '../src/routes/incidents.js';
import { listIncidents, updateIncident } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listIncidents: vi.fn(),
  createIncident: vi.fn(),
  updateIncident: vi.fn(),
}));

const listMock = vi.mocked(listIncidents);
const updateMock = vi.mocked(updateIncident);

describe('Incidents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists incidents and advances status', async () => {
    listMock.mockResolvedValue([
      { id: 'i-1', title: 'checkout latency', severity: 'P1', status: 'open', commanderId: null },
    ]);
    updateMock.mockResolvedValue({
      id: 'i-1',
      title: 'checkout latency',
      severity: 'P1',
      status: 'investigating',
      commanderId: null,
    });
    render(<Incidents onBack={vi.fn()} />);
    expect(await screen.findByText('checkout latency')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始排查' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('i-1', { status: 'investigating' }));
    expect(await screen.findByText('investigating')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Incidents onBack={vi.fn()} />);
    expect(await screen.findByText('暂无事件')).toBeInTheDocument();
  });
});
