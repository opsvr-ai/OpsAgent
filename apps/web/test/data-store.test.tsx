import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataStore } from '../src/routes/data-store.js';
import { getDataStore } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  getDataStore: vi.fn(),
  cleanupDataStore: vi.fn(),
}));

const statsMock = vi.mocked(getDataStore);

describe('DataStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows snapshot stats and recent rows', async () => {
    statsMock.mockResolvedValue({
      count: 2,
      bytes: 30,
      oldest: '2026-10-01T00:00:00.000Z',
      newest: '2026-11-03T00:00:00.000Z',
      quotaBytes: 100,
      usagePct: 30,
      datasets: [
        { tool: 'promql_query', count: 2, bytes: 30, lastSync: '2026-11-03T00:00:00.000Z' },
      ],
      recent: [
        {
          id: 's-1',
          tool: 'promql_query',
          bytes: 20,
          createdAt: '2026-11-03T00:00:00.000Z',
          expiresAt: null,
        },
      ],
    });
    render(<DataStore onBack={vi.fn()} />);
    expect(await screen.findByText('2 条快照')).toBeInTheDocument();
    expect(screen.getAllByText('promql_query').length).toBeGreaterThan(0);
  });
});
