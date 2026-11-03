import type { ReactNode } from 'react';
import { ThemeToggle } from '../theme/use-theme.js';
import { GlobalSearch } from './global-search.js';
import { useSession } from '../session-context.js';
import { AppSidebar } from './app-sidebar.js';
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

  return (
    <div className="app">
      <AppSidebar active={active} onHome={onBack} platform={platform} />

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
