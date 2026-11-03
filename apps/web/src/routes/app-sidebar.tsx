import { useEffect, useState } from 'react';
import { useSession } from '../session-context.js';
import { NAV, type DesignNav } from './nav.js';

export interface AppSidebarProps {
  readonly active: DesignNav;
  readonly onHome: () => void;
  readonly platform?: boolean;
}

const PLATFORM_NAV: Array<{ id: DesignNav; label: string; icon: string }> = [
  { id: 'home', label: '租户管理', icon: 'building' },
];

export function AppSidebar({ active, onHome, platform = false }: AppSidebarProps) {
  const session = useSession();
  const [tenantMenu, setTenantMenu] = useState(false);
  useEffect(() => {
    if (!tenantMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.tenant-switch') && !target?.closest('.tenant-menu')) {
        setTenantMenu(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [tenantMenu]);
  const tenant = session?.home
    ? session.me.tenants.find((item) => item.id === session.home?.tenantId)
    : session?.me.tenants[0];
  const userName = session?.me.user.displayName ?? '开发管理员';
  const roleView = session?.home?.roleView ?? 'tenant_admin';
  const items = platform ? PLATFORM_NAV : NAV;
  const count = (id: string): number => {
    if (!session?.home) return 0;
    if (id === 'messages') return session.home.metrics.messagesUnread;
    if (id === 'approvals') return session.home.metrics.pendingApprovals;
    return 0;
  };

  function go(id: DesignNav): void {
    if (id === 'home') {
      onHome();
      return;
    }
    window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: id }));
  }

  return (
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
          if (platform) onHome();
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
                void session?.switchTenant?.(item.id).then(onHome).catch(() => undefined);
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
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${item.id === active ? ' is-active' : ''}`}
              onClick={() => go(item.id)}
            >
              <svg><use href={`/icons.svg#i-${item.icon}`} /></svg>
              {item.label}
              {count(item.id) > 0 ? <span className="nav-badge is-alert">{count(item.id)}</span> : null}
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
        <button type="button" className="user-chip" onClick={onHome}>
          <span className="avatar is-green">{userName.slice(0, 1)}</span>
          <span className="grow">
            <strong>{userName}</strong>
            <span>{platform ? '平台管理员' : roleView}</span>
          </span>
        </button>
        <button type="button" className="logout-link" onClick={() => window.dispatchEvent(new Event('opsagent:logout'))}>退出登录</button>
      </div>
    </aside>
  );
}
