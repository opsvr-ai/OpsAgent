import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scenarios } from '../src/routes/scenarios.js';
import { listScenarios, runScenario } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listScenarios: vi.fn(),
  runScenario: vi.fn(),
}));

const listMock = vi.mocked(listScenarios);
const runMock = vi.mocked(runScenario);

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
      },
    ]);
    runMock.mockResolvedValue({ status: 'success', results: [] });

    render(<Scenarios onBack={vi.fn()} />);
    expect(await screen.findByText('daily-check')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '运行' }));

    await waitFor(() => expect(runMock).toHaveBeenCalledWith('s-1'));
    expect(await screen.findByText('success')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Scenarios onBack={vi.fn()} />);
    expect(await screen.findByText('暂无场景')).toBeInTheDocument();
  });
});
