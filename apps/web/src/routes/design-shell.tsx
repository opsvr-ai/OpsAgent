import { useState, type ReactNode } from 'react';
import { ThemeToggle } from '../theme/use-theme.js';
import { GlobalSearch } from './global-search.js';
import { useSession } from '../session-context.js';

import { NAV, type DesignNav } from './nav.js';

export { NAV };
export type { DesignNav };

export interface DesignShellProps {
  readonly active: DesignNav;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack: () => void;
  readonly actions?: ReactNode;
  readonly platform?: boolean;
  readonly children: ReactNode;
}

export function DesignShell({ active, eyebrow, title, subtitle, onBack, actions, platform = false, children }: DesignShellProps) {
  const session = useSession();
  const [tenantMenu, setTenantMenu] = useState(false);
  const navItems = platform
    ? [{ id: 'home' as const, label: '租户管理', icon: 'building' }]
    : NAV;
  const tenant = session?.home
    ? session.me.tenants.find((item) => item.id === session.home?.tenantId)
    : session?.me.tenants[0];
  const userName = session?.me.user.displayName ?? '开发管理员';
  const roleView = session?.home?.roleView ?? 'tenant_admin';
  const navCount = (id: string): number => {
    if (!session?.home) return 0;
    if (id === 'messages') return session.home.metrics.messagesUnread;
    if (id === 'approvals') return session.home.metrics.pendingApprovals;
    return 0;
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7l5 5-5 5" />
              <path d="M12 17h8" />
            </svg>
          </div>
          <div>
            <div className="brand-name">OpsAgent</div>
            <span className="brand-sub">AIOps Control Plane</span>
          </div>
        </div>
        <button
          type="button"
          className="tenant-switch"
          aria-expanded={tenantMenu}
          onClick={() => {
            if (platform) onBack();
            else setTenantMenu((current) => !current);
          }}
        >
          <span className="avatar">{platform ? 'P' : (tenant?.name ?? '开发租户').slice(0, 1)}</span>
          <span className="tenant-meta">
            <strong>{platform ? '平台控制台' : (tenant?.name ?? '开发租户')}</strong>
            <span>{platform ? 'platform-admin · 平台管理员' : `${tenant?.slug ?? 'tenant-demo'} · 本地开发`}</span>
          </span>
        </button>
        {tenantMenu && !platform ? (
          <div className="tenant-menu">
            <div className="nav-label">切换租户</div>
            {(session?.me.tenants ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`tenant-option${item.id === tenant?.id ? ' is-active' : ''}`}
                onClick={() => {
                  setTenantMenu(false);
                  void session?.switchTenant?.(item.id).then(onBack).catch(() => undefined);
                }}
              >
                <span className="avatar">{item.name.slice(0, 1)}</span>
                <span className="grow">
                  <strong>{item.name}</strong>
                  <span>{item.slug}</span>
                </span>
                {item.id === tenant?.id ? <span className="badge badge-ok">当前</span> : null}
              </button>
            ))}
            {(session?.me.tenants ?? []).length === 0 ? <p className="muted">暂无可用租户</p> : null}
          </div>
        ) : null}
        <nav className="nav">
          <div className="nav-group">
            <div className="nav-label">{platform ? '平台管理' : '工作空间'}</div>
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item${item.id === active ? ' is-active' : ''}`}
                onClick={() => {
                  if (item.id === active) return;
                  if (item.id === 'home') {
                    onBack();
                    return;
                  }
                  window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: item.id }));
                }}
              >
                <svg><use href={`/icons.svg#i-${item.icon}`} /></svg>
                {item.label}
                {navCount(item.id) > 0 ? <span className="nav-badge is-alert">{navCount(item.id)}</span> : null}
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-foot">
          <div className="runtime-card">
            <span className="dot dot-ok" />
            <div>
              <strong>{platform ? '平台控制台' : '开发运行时'}</strong>
              <span>{platform ? '多租户治理 · 本地开发' : '单节点 · 本地容器'}</span>
            </div>
          </div>
          <button type="button" className="user-chip" onClick={onBack}>
            <span className="avatar is-green">{userName.slice(0, 1)}</span>
            <span className="grow">
              <strong>{userName}</strong>
              <span>{platform ? '平台管理员' : roleView}</span>
            </span>
          </button>
          <button type="button" className="logout-link" onClick={() => window.dispatchEvent(new Event('opsagent:logout'))}>退出登录</button>
        </div>
      </aside>

      <section className="main">
        <header className="topbar">
          <div className="crumbs">
            <button type="button" className="crumbs-link" onClick={onBack}>{platform ? '平台' : '工作台'}</button>
            <span className="sep">/</span>
            <span className="current">{title}</span>
          </div>
          <div className="topbar-spacer" />
          {platform ? null : <GlobalSearch />}
          <ThemeToggle />
          {platform ? null : (
            <>
              <button type="button" className="topbar-icon" aria-label="消息中心" onClick={() => window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'messages' }))}>
                <svg><use href="/icons.svg#i-bell" /></svg>
                {(session?.home?.metrics.messagesUnread ?? 0) > 0 ? <span className="topbar-badge">{session?.home?.metrics.messagesUnread}</span> : null}
              </button>
              <button type="button" className="topbar-icon" aria-label="待审批" onClick={() => window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'approvals' }))}>
                <svg><use href="/icons.svg#i-check" /></svg>
                {(session?.home?.metrics.pendingApprovals ?? 0) > 0 ? <span className="topbar-badge">{session?.home?.metrics.pendingApprovals}</span> : null}
              </button>
            </>
          )}
          <span className="env-pill"><span className="dot dot-ok" style={{ width: 5, height: 5 }} />本地开发</span>
        </header>
        <main className="page">
          <div className="page-inner">
            <div className="page-head">
              <div>
                <div className="eyebrow">{eyebrow}</div>
                <h1 style={{ marginTop: 8 }}>{title}</h1>
                {subtitle ? <p className="sub">{subtitle}</p> : null}
              </div>
              {actions ? <div className="page-actions">{actions}</div> : null}
            </div>
            {children}
          </div>
        </main>
      </section>
    </div>
  );
}
