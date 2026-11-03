import type { ReactNode } from 'react';

export type DesignNav = 'home' | 'incidents' | 'scenarios' | 'approvals' | 'shares' | 'studio' | 'audit';

export interface DesignShellProps {
  readonly active: DesignNav;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack: () => void;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

const NAV: Array<{ id: DesignNav; label: string }> = [
  { id: 'home', label: '工作台' },
  { id: 'incidents', label: '事件指挥' },
  { id: 'approvals', label: '待审批' },
  { id: 'scenarios', label: '场景中心' },
  { id: 'shares', label: '共享审批' },
  { id: 'studio', label: '创造模式' },
  { id: 'audit', label: '审计' },
];

export function DesignShell({ active, eyebrow, title, subtitle, onBack, actions, children }: DesignShellProps) {
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
        <button type="button" className="tenant-switch" onClick={onBack}>
          <span className="avatar">开</span>
          <span className="tenant-meta">
            <strong>开发租户</strong>
            <span>本地容器 · 单节点</span>
          </span>
        </button>
        <nav className="nav">
          <div className="nav-group">
            <div className="nav-label">工作空间</div>
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item${item.id === active ? ' is-active' : ''}`}
                onClick={item.id === 'home' ? onBack : undefined}
              >
                {item.label}
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-foot">
          <div className="runtime-card">
            <span className="dot dot-ok" />
            <div>
              <strong>开发运行时</strong>
              <span>单节点 · 本地容器</span>
            </div>
          </div>
          <button type="button" className="user-chip" onClick={onBack}>
            <span className="avatar is-green">开</span>
            <span className="grow">
              <strong>开发管理员</strong>
              <span>tenant_admin</span>
            </span>
          </button>
        </div>
      </aside>

      <section className="main">
        <header className="topbar">
          <div className="crumbs">
            <button type="button" className="crumbs-link" onClick={onBack}>工作台</button>
            <span className="sep">/</span>
            <span className="current">{title}</span>
          </div>
          <div className="topbar-spacer" />
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
