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
          metrics: {
            connectors: 2,
            incidentsOpen: 1,
            scenarios: 3,
            pendingApprovals: 0,
            activeSessions: 1,
          },
          recentIncidents: [],
          recentSessions: [],
        }}
        onStartSession={onStartSession}
        onOpenScenarios={vi.fn()}
        onOpenAudit={vi.fn()}
        onOpenShares={vi.fn()}
        onOpenStudio={vi.fn()}
        onOpenIncidents={vi.fn()}
        onOpenApprovals={vi.fn()}
        onOpenConnectors={vi.fn()}
        onOpenKnowledge={vi.fn()}
        onOpenMessages={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenSessions={vi.fn()}
        onOpenMembers={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenData={vi.fn()}
        onSwitchTenant={vi.fn()}
      />,
    );

    expect(screen.getAllByText('tenant_admin').length).toBeGreaterThan(0);
    expect(screen.getAllByText('事件指挥').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(onStartSession).toHaveBeenCalledOnce();
  });
});
