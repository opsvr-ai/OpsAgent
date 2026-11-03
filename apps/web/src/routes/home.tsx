import type { HomeResponse, MeResponse } from '@opsagent/contracts';

export interface HomeProps {
  readonly me: MeResponse;
  readonly home: HomeResponse;
  readonly onStartSession: () => void;
  readonly onOpenScenarios: () => void;
  readonly onOpenAudit: () => void;
  readonly onOpenShares: () => void;
  readonly onOpenStudio: () => void;
}

export function Home({ me, home, onStartSession, onOpenScenarios, onOpenAudit, onOpenShares, onOpenStudio }: HomeProps) {
  const tenant = me.tenants.find((item) => item.id === home.tenantId);
  const name = me.user.displayName || me.user.username;

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

        <button type="button" className="tenant-switch" onClick={onStartSession}>
          <span className="avatar">{(tenant?.name ?? '租').slice(0, 1)}</span>
          <span className="tenant-meta">
            <strong>{tenant?.name ?? home.tenantId}</strong>
            <span>{tenant?.slug ?? 'tenant'} · 本地开发</span>
          </span>
        </button>

        <nav className="nav">
          <div className="nav-group">
            <div className="nav-label">工作空间</div>
            <button type="button" className="nav-item is-active"><span>工作台</span></button>
            <button type="button" className="nav-item" onClick={onStartSession}><span>智能体会话</span></button>
            <button type="button" className="nav-item" onClick={onOpenScenarios}><span>场景中心</span></button>
            <button type="button" className="nav-item" onClick={onOpenShares}><span>共享审批</span></button>
            <button type="button" className="nav-item" onClick={onOpenStudio}><span>创造模式</span></button>
            <button type="button" className="nav-item" onClick={onOpenAudit}><span>审计</span></button>
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
          <button type="button" className="user-chip">
            <span className="avatar is-green">{name.slice(0, 1)}</span>
            <span className="grow">
              <strong>{name}</strong>
              <span>{home.roleView}</span>
            </span>
          </button>
        </div>
      </aside>

      <section className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>工作台</span>
            <span className="sep">/</span>
            <span className="current">总览</span>
          </div>
          <div className="topbar-spacer" />
          <span className="env-pill"><span className="dot dot-ok" style={{ width: 5, height: 5 }} />本地开发</span>
        </header>

        <main className="page">
          <div className="page-inner">
            <div className="page-head">
              <div>
                <div className="eyebrow">OpsAgent · AIOps Control Plane</div>
                <h1 style={{ marginTop: 8 }}>早上好，{name}</h1>
                <p className="sub">
                  当前租户 {tenant?.name ?? home.tenantId}，视角 {home.roleView}。
                  从这里进入会话、场景、连接器与审计。
                </p>
                <div className="row-sm" style={{ marginTop: 10 }}>
                  <span className="eyebrow">当前视角</span>
                  <span className="tag is-active">{home.roleView}</span>
                  <span className="hint">切换视角调整导航与首屏模块，权限不放大。</span>
                </div>
              </div>
              <div className="page-actions">
                <button type="button" className="btn btn-outline" onClick={onOpenScenarios}>场景中心</button>
                <button type="button" className="btn btn-primary" onClick={onStartSession}>新建会话</button>
              </div>
            </div>

            <div className="status-strip" style={{ marginBottom: 24 }}>
              <div className="status-cell"><span className="dot dot-ok" /><div><strong>Control Plane</strong><span>healthy</span></div></div>
              <div className="status-cell"><span className="dot dot-ok" /><div><strong>PostgreSQL</strong><span>RLS enforced</span></div></div>
              <div className="status-cell"><span className="dot dot-ok" /><div><strong>Connectors</strong><span>9 类已注册</span></div></div>
              <div className="status-cell"><span className="dot dot-ok" /><div><strong>Audit</strong><span>streaming</span></div></div>
            </div>

            <div className="grid grid-3">
              {home.cards.map((card) => (
                <button key={card.id} type="button" className="card scenario-card" onClick={onStartSession}>
                  <div className="card-body">
                    <div className="scenario-top">
                      <span className="icon-tile is-blue">◆</span>
                      <span className="badge badge-neutral">{home.roleView}</span>
                    </div>
                    <h3>{card.title}</h3>
                    <p className="muted">{tenant?.name ?? home.tenantId} · {card.id}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </main>
      </section>
    </div>
  );
}
