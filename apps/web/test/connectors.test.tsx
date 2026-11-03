import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Connectors } from '../src/routes/connectors.js';
import { listConnectors, testConnector } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listConnectors: vi.fn(),
  createConnector: vi.fn(),
  testConnector: vi.fn(),
}));

const listMock = vi.mocked(listConnectors);
const testMock = vi.mocked(testConnector);

describe('Connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists connectors and probes one', async () => {
    listMock.mockResolvedValue([
      {
        id: 'c-1',
        name: 'prod-prom',
        connectorType: 'prometheus',
        status: 'draft',
        config: {},
        credentialRef: null,
      },
    ]);
    testMock.mockResolvedValue({ status: 'healthy', latencyMs: 12 });
    render(<Connectors onBack={vi.fn()} />);
    expect((await screen.findAllByText('prod-prom')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(testMock).toHaveBeenCalledWith('c-1'));
    expect(await screen.findByText('healthy · 12ms')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Connectors onBack={vi.fn()} />);
    expect(await screen.findByText('暂无连接器')).toBeInTheDocument();
  });
});
