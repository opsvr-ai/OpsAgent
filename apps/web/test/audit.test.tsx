import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Audit } from '../src/routes/audit.js';
import { listAudit } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listAudit: vi.fn(),
}));

const listMock = vi.mocked(listAudit);

describe('Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists audit events', async () => {
    listMock.mockResolvedValue([
      {
        id: 'a-1',
        action: 'auth.login',
        actorId: 'u-1',
        resource: 'local-admin',
        result: 'success',
        metadata: {},
        createdAt: '2026-11-03T12:00:00.000Z',
      },
    ]);
    render(<Audit onBack={vi.fn()} />);
    expect(await screen.findByText('auth.login')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Audit onBack={vi.fn()} />);
    expect(await screen.findByText('暂无审计事件')).toBeInTheDocument();
  });
});
