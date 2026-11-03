import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scenarios } from '../src/routes/scenarios.js';
import { listScenarios, runScenario, setScenarioSchedule } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listScenarios: vi.fn(),
  runScenario: vi.fn(),
  setScenarioSchedule: vi.fn(),
}));

const listMock = vi.mocked(listScenarios);
const runMock = vi.mocked(runScenario);
const scheduleMock = vi.mocked(setScenarioSchedule);

describe('Scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists scenarios and runs one', async () => {
    listMock.mockResolvedValue([
      {
        id: 's-1',
        name: 'daily-check',
        description: 'daily',
        status: 'published',
        version: 1,
        definition: { steps: [] },
        scheduleIntervalMinutes: 60,
      },
    ]);
    runMock.mockResolvedValue({ status: 'success', results: [] });

    render(<Scenarios onBack={vi.fn()} />);
    expect(await screen.findByText('daily-check')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '运行' }));

    await waitFor(() => expect(runMock).toHaveBeenCalledWith('s-1'));
    expect(await screen.findByText('success')).toBeInTheDocument();
    expect(screen.getByText('每 60 分钟')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('定时分钟'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '设置定时' }));
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledWith('s-1', 30));
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Scenarios onBack={vi.fn()} />);
    expect(await screen.findByText('暂无场景')).toBeInTheDocument();
  });
});
