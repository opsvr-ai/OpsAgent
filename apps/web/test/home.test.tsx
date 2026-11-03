import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Home } from '../src/routes/home.js';

describe('Home', () => {
  it('shows the role view and starts a session', () => {
    const onStartSession = vi.fn();
    render(
      <Home
        me={{
          user: { id: 'u-1', username: 'tenant-admin', displayName: 'Tenant Admin', isPlatformAdmin: false },
          tenants: [
            {
              id: 't-1',
              slug: 'tenant-demo',
              name: 'Demo Tenant',
              roles: ['tenant_admin'],
              permissions: ['tenant.member.manage'],
            },
          ],
        }}
        home={{
          tenantId: 't-1',
          roleView: 'tenant_admin',
          cards: [{ id: 'incidents', title: '事件指挥' }],
        }}
        onStartSession={onStartSession}
      />,
    );

    expect(screen.getByText('tenant_admin')).toBeInTheDocument();
    expect(screen.getAllByText('事件指挥').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '进入会话' }));
    expect(onStartSession).toHaveBeenCalledOnce();
  });
});
