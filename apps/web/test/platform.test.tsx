import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from '../src/routes/platform.js';
import { listPlatformTenants } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listPlatformTenants: vi.fn(),
  createPlatformTenant: vi.fn(),
  getPlatformTlsStatus: vi.fn(async () => ({ configured: false })),
}));

const listMock = vi.mocked(listPlatformTenants);

describe('Platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists tenants', async () => {
    listMock.mockResolvedValue([
      { id: 't-1', name: 'Demo Tenant', slug: 'tenant-demo', status: 'active' },
    ]);
    render(<Platform onRefresh={vi.fn()} />);
    expect(await screen.findByText('Demo Tenant')).toBeInTheDocument();
    expect(screen.getByText('tenant-demo')).toBeInTheDocument();
  });
});
