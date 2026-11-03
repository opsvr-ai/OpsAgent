import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Connectors } from '../src/routes/connectors.js';
import { getConnector, listConnectors, testConnector } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listConnectors: vi.fn(),
  createConnector: vi.fn(),
  testConnector: vi.fn(),
  getConnector: vi.fn(),
  saveConnectorCredentials: vi.fn(),
}));

const listMock = vi.mocked(listConnectors);
const testMock = vi.mocked(testConnector);
const detailMock = vi.mocked(getConnector);

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

  it('opens the connector detail configuration', async () => {
    listMock.mockResolvedValue([
      {
        id: 'c-1',
        name: 'prod-prom',
        connectorType: 'prometheus',
        status: 'active',
        config: { baseUrl: 'http://prometheus:9090' },
        credentialRef: null,
      },
    ]);
    detailMock.mockResolvedValue({
      id: 'c-1',
      name: 'prod-prom',
      connectorType: 'prometheus',
      status: 'active',
      config: { baseUrl: 'http://prometheus:9090' },
      credentialRef: null,
      hasCredentials: true,
    });
    render(<Connectors onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '详情' }));
    expect(await screen.findByText('基本连接')).toBeInTheDocument();
    expect(screen.getByText('连接测试')).toBeInTheDocument();
    expect(screen.getByText('能力与工具')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Connectors onBack={vi.fn()} />);
    expect(await screen.findByText('暂无连接器')).toBeInTheDocument();
  });
});
