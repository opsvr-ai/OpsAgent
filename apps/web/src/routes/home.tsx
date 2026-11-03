import { useState } from 'react';
import type { HomeResponse, MeResponse } from '@opsagent/contracts';
import { ThemeToggle } from '../theme/use-theme.js';

export interface HomeProps {
  readonly me: MeResponse;
  readonly home: HomeResponse;
  readonly onStartSession: () => void;
  readonly onOpenScenarios: () => void;
  readonly onOpenAudit: () => void;
  readonly onOpenShares: () => void;
  readonly onOpenStudio: () => void;
  readonly onOpenIncidents: () => void;
  readonly onOpenApprovals: () => void;
  readonly onOpenConnectors: () => void;
  readonly onOpenKnowledge: () => void;
  readonly onOpenMessages: () => void;
  readonly onOpenAgents: () => void;
  readonly onOpenTasks: () => void;
  readonly onOpenSessions: () => void;
  readonly onOpenMembers: () => void;
  readonly onOpenModels: () => void;
  readonly onOpenData: () => void;
  readonly onOpenAppearance: () => void;
  readonly onOpenHelp: () => void;
  readonly onSwitchTenant: (tenantId: string) => void;
}

export function Home({ me, home, onStartSession, onOpenScenarios, onOpenAudit, onOpenShares, onOpenStudio, onOpenIncidents, onOpenApprovals, onOpenConnectors, onOpenKnowledge, onOpenMessages, onOpenAgents, onOpenTasks, onOpenSessions, onOpenMembers, onOpenModels, onOpenData, onOpenAppearance, onOpenHelp, onSwitchTenant }: HomeProps) {
  const [switchOpen, setSwitchOpen] = useState(false);
  const tenant = me.tenants.find((item) => item.id === home.tenantId);
  const name = me.user.displayName || me.user.username;
  const cardActions: Record<string, () => void> = {
    incidents: onOpenIncidents,
    agents: onOpenAgents,
    knowledge: onOpenKnowledge,
    scenarios: onOpenScenarios,
    approvals: onOpenApprovals,
    connectors: onOpenConnectors,
    messages: onOpenMessages,
    tasks: onOpenTasks,
    audit: onOpenAudit,
  };
  const cardCopy: Record<string, string> = {
    incidents: '查看事件时间线，推进排查、恢复与关闭。',
    agents: '安装服务器 Agent，查看心跳、指标并执行诊断。',
    knowledge: '沉淀排障经验，经审核后发布给团队。',
    scenarios: '编排标准化处置步骤，按风险审批执行。',
    approvals: '集中处理运行时、场景与共享审批。',
    connectors: '接入监控、数据库、主机与 HTTP 服务。',
    messages: '查看事件与审批产生的站内通知。',
    tasks: '在后台执行长场景，审批挂起后可继续。',
    audit: '检索、筛选并导出租户审计事件。',
  };
  const cardIcons: Record<string, string> = {
    incidents: 'activity',
    agents: 'server',
    knowledge: 'book',
    scenarios: 'bolt',
    approvals: 'check',
    connectors: 'plug',
    messages: 'bell',
    tasks: 'clock',
    audit: 'shield',
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

        <button type="button" className="tenant-switch" onClick={() => setSwitchOpen((open) => !open)}>
          <span className="avatar">{(tenant?.name ?? '租').slice(0, 1)}</span>
          <span className="tenant-meta">
            <strong>{tenant?.name ?? home.tenantId}</strong>
            <span>{tenant?.slug ?? 'tenant'} · 本地开发</span>
          </span>
        </button>
        {switchOpen ? (
          <div className="tenant-menu">
            {me.tenants.map((item) => (
              <button
                key={item.id}
                type="button"
                className="tenant-menu-item"
                onClick={() => {
                  setSwitchOpen(false);
                  onSwitchTenant(item.id);
                }}
              >
                <strong>{item.name}</strong>
                <span>{item.slug}</span>
              </button>
            ))}
          </div>
        ) : null}

        <nav className="nav">
          <div className="nav-group">
            <div className="nav-label">工作空间</div>
            <button type="button" className="nav-item is-active"><svg><use href="/icons.svg#i-grid" /></svg><span>工作台</span></button>
            <button type="button" className="nav-item" onClick={onStartSession}><svg><use href="/icons.svg#i-message" /></svg><span>智能体会话</span></button>
            <button type="button" className="nav-item" onClick={onOpenScenarios}><svg><use href="/icons.svg#i-bolt" /></svg><span>场景中心</span></button>
            <button type="button" className="nav-item" onClick={onOpenIncidents}><svg><use href="/icons.svg#i-activity" /></svg><span>事件指挥</span></button>
            <button type="button" className="nav-item" onClick={onOpenApprovals}><svg><use href="/icons.svg#i-check" /></svg><span>待审批</span></button>
            <button type="button" className="nav-item" onClick={onOpenConnectors}><svg><use href="/icons.svg#i-plug" /></svg><span>集成与连接器</span></button>
            <button type="button" className="nav-item" onClick={onOpenKnowledge}><svg><use href="/icons.svg#i-book" /></svg><span>知识中心</span></button>
            <button type="button" className="nav-item" onClick={onOpenMessages}><svg><use href="/icons.svg#i-bell" /></svg><span>消息中心</span></button>
            <button type="button" className="nav-item" onClick={onOpenAgents}><svg><use href="/icons.svg#i-server" /></svg><span>服务器 Agent</span></button>
            <button type="button" className="nav-item" onClick={onOpenTasks}><svg><use href="/icons.svg#i-clock" /></svg><span>长任务</span></button>
            <button type="button" className="nav-item" onClick={onOpenSessions}><svg><use href="/icons.svg#i-message" /></svg><span>会话历史</span></button>
            <button type="button" className="nav-item" onClick={onOpenMembers}><svg><use href="/icons.svg#i-users" /></svg><span>成员与角色</span></button>
            <button type="button" className="nav-item" onClick={onOpenModels}><svg><use href="/icons.svg#i-shield" /></svg><span>模型配置</span></button>
            <button type="button" className="nav-item" onClick={onOpenData}><svg><use href="/icons.svg#i-database" /></svg><span>数据沉淀</span></button>
            <button type="button" className="nav-item" onClick={onOpenAppearance}><svg><use href="/icons.svg#i-sun" /></svg><span>外观与主题</span></button>
            <button type="button" className="nav-item" onClick={onOpenHelp}><svg><use href="/icons.svg#i-book" /></svg><span>用户手册</span></button>
            <button type="button" className="nav-item" onClick={onOpenShares}><svg><use href="/icons.svg#i-share" /></svg><span>共享审批</span></button>
            <button type="button" className="nav-item" onClick={onOpenStudio}><svg><use href="/icons.svg#i-wand" /></svg><span>创造模式</span></button>
            <button type="button" className="nav-item" onClick={onOpenAudit}><svg><use href="/icons.svg#i-shield" /></svg><span>审计</span></button>
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
            <svg><use href="/icons.svg#i-grid" /></svg><span>工作台</span>
            <span className="sep">/</span>
            <span className="current">总览</span>
          </div>
          <div className="topbar-spacer" />
          <ThemeToggle />
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
              <div className="status-cell"><span className="dot dot-ok" /><div><strong>连接器</strong><span>{home.metrics.connectors} 个已配置</span></div></div>
              <div className="status-cell"><span className="dot dot-warn" /><div><strong>待处置事件</strong><span>{home.metrics.incidentsOpen} 个</span></div></div>
              <div className="status-cell"><span className="dot dot-ok" /><div><strong>场景</strong><span>{home.metrics.scenarios} 个</span></div></div>
              <div className="status-cell"><span className="dot dot-warn" /><div><strong>待审批</strong><span>{home.metrics.pendingApprovals} 项</span></div></div>
            </div>

            <div className="grid grid-main-side">
              <section className="card">
                <div className="card-head"><h2>最近事件</h2><span className="muted">{home.metrics.activeSessions} 个进行中会话</span></div>
                <div className="card-body">
                  {home.recentIncidents.length === 0 ? <p className="muted">暂无事件</p> : (
                    <table className="table">
                      <thead><tr><th>等级</th><th>事件</th><th>状态</th></tr></thead>
                      <tbody>
                        {home.recentIncidents.map((incident) => (
                          <tr key={incident.id}>
                            <td><span className="badge badge-neutral">{incident.severity}</span></td>
                            <td>{incident.title}</td>
                            <td>{incident.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>

              <section className="card">
                <div className="card-head"><h2>最近会话</h2></div>
                <div className="card-body">
                  {home.recentSessions.length === 0 ? <p className="muted">暂无会话</p> : (
                    <div className="stack-sm">
                      {home.recentSessions.map((session) => (
                        <div key={session.id} className="session-row">
                          <span className="mono session-id">{session.id.slice(0, 18)}</span>
                          <span className="badge badge-neutral">{session.roleView}</span>
                          <span className="muted">{session.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="grid grid-3">
              {home.cards.map((card) => (
                <button key={card.id} type="button" className="card scenario-card home-card" onClick={cardActions[card.id] ?? onStartSession}>
                  <div className="card-body">
                    <div className="scenario-top">
                      <span className="icon-tile is-blue">
                        <svg><use href={`/icons.svg#i-${cardIcons[card.id] ?? 'grid'}`} /></svg>
                      </span>
                      <span className="badge badge-neutral">{home.roleView}</span>
                    </div>
                    <h3>{card.title}</h3>
                    <p className="muted">{cardCopy[card.id] ?? `${tenant?.name ?? home.tenantId} 的工作区`}</p>
                    <span className="home-card-link">进入 →</span>
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
