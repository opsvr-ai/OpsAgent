import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Incidents } from '../src/routes/incidents.js';
import { getIncident, listIncidents, updateIncident } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listIncidents: vi.fn(),
  createIncident: vi.fn(),
  updateIncident: vi.fn(),
  getIncident: vi.fn(),
  getIncidentInstructions: vi.fn().mockResolvedValue([]),
  listMembers: vi.fn().mockResolvedValue([]),
}));

const listMock = vi.mocked(listIncidents);
const updateMock = vi.mocked(updateIncident);
const detailMock = vi.mocked(getIncident);

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
    detailMock.mockResolvedValue({
      incident: {
        id: 'i-1',
        title: 'checkout latency',
        severity: 'P1',
        status: 'open',
        commanderId: null,
      },
      events: [],
    });
    render(<Incidents onBack={vi.fn()} />);
    expect((await screen.findAllByText('checkout latency')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '开始排查' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('i-1', { status: 'investigating' }));
    expect((await screen.findAllByText('investigating', {}, { timeout: 3000 })).length).toBeGreaterThan(0);
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Incidents onBack={vi.fn()} />);
    expect(await screen.findByText('暂无事件')).toBeInTheDocument();
  });
});
