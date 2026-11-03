import type { HomeResponse, MeResponse } from '@opsagent/contracts';
import { ThemeToggle } from '../theme/use-theme.js';
import { GlobalSearch } from './global-search.js';
import { AppSidebar } from './app-sidebar.js';

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

export function Home({ me, home, onStartSession, onOpenScenarios, onOpenAudit, onOpenShares, onOpenStudio, onOpenIncidents, onOpenApprovals, onOpenConnectors, onOpenKnowledge, onOpenMessages, onOpenAgents, onOpenTasks, onOpenSessions, onOpenMembers, onOpenModels, onOpenData, onOpenAppearance, onOpenHelp }: HomeProps) {
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
  const unresolvedIncidents = home.recentIncidents.filter((incident) => incident.status !== 'resolved' && incident.status !== 'closed');
  const now = new Date();
  const today = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${now.toLocaleDateString('zh-CN', { weekday: 'long' })}`;

  return (
    <div className="app">
        <AppSidebar active="home" onHome={() => undefined} />

      <section className="main">
        <header className="topbar">
          <div className="crumbs">
            <svg><use href="/icons.svg#i-grid" /></svg><span>工作台</span>
            <span className="sep">/</span>
            <span className="current">总览</span>
          </div>
          <div className="topbar-spacer" />
          <GlobalSearch />
          <ThemeToggle />
          <button type="button" className="topbar-icon" aria-label="消息中心" onClick={onOpenMessages}><svg><use href="/icons.svg#i-bell" /></svg>{home.metrics.messagesUnread > 0 ? <span className="topbar-badge">{home.metrics.messagesUnread}</span> : null}</button>
          <button type="button" className="topbar-icon" aria-label="待审批" onClick={onOpenApprovals}><svg><use href="/icons.svg#i-check" /></svg>{home.metrics.pendingApprovals > 0 ? <span className="topbar-badge">{home.metrics.pendingApprovals}</span> : null}</button>
          <span className="env-pill"><span className="dot dot-ok" style={{ width: 5, height: 5 }} />本地开发</span>
        </header>

        <main className="page">
          <div className="page-inner">
            <div className="page-head">
              <div>
                <div className="eyebrow">OpsAgent · AIOps Control Plane</div>
                <div className="muted" style={{ marginTop: 4 }}>{today}</div>
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
                <button type="button" className="btn btn-outline" onClick={onOpenScenarios}>运行巡检</button>
                <button type="button" className="btn btn-primary" onClick={onStartSession}>新建会话</button>
              </div>
            </div>

            <div className="status-strip" style={{ marginBottom: 24 }}>
              <div className="status-cell">
                <span className="icon-tile is-green"><svg><use href="/icons.svg#i-server" /></svg></span>
                <div><strong>Agent 运行</strong><span>{home.metrics.agentsOnline} / {home.metrics.agentsTotal} 在线</span></div>
                <span className="cell-end">{home.metrics.agentsTotal > 0 ? Math.round((home.metrics.agentsOnline / home.metrics.agentsTotal) * 100) : 0}%</span>
              </div>
              <div className="status-cell">
                <span className="icon-tile is-blue"><svg><use href="/icons.svg#i-plug" /></svg></span>
                <div><strong>连接器</strong><span>{home.metrics.connectors} 个已配置</span></div>
                <span className="cell-end">{home.metrics.connectors}</span>
              </div>
              <div className="status-cell">
                <span className="icon-tile is-amber"><svg><use href="/icons.svg#i-activity" /></svg></span>
                <div><strong>待处置事件</strong><span>{home.metrics.incidentsOpen} 个未关闭</span></div>
                <span className="cell-end">{home.metrics.incidentsOpen}</span>
              </div>
              <div className="status-cell">
                <span className="icon-tile"><svg><use href="/icons.svg#i-check" /></svg></span>
                <div><strong>待审批</strong><span>{home.metrics.pendingApprovals} 项</span></div>
                <span className="cell-end">{home.metrics.pendingApprovals}</span>
              </div>
            </div>

            <div className="grid grid-main-side">
              <div className="stack">
                <section className="card">
                  <div className="card-head"><h2>需要关注</h2><span className="badge badge-warn">{unresolvedIncidents.length} 未关闭</span></div>
                  <div className="card-body">
                    {unresolvedIncidents.length === 0 ? <p className="muted">暂无未关闭事件</p> : (
                      <table className="table">
                        <thead><tr><th>等级</th><th>事件</th><th>状态</th><th /></tr></thead>
                        <tbody>
                          {unresolvedIncidents.map((incident) => (
                            <tr key={incident.id}>
                              <td><span className="badge badge-neutral">{incident.severity}</span></td>
                              <td className="cell-main">{incident.title}</td>
                              <td>{incident.status}</td>
                              <td className="actions-cell">
                                <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenIncidents}>处理</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </section>

                <section className="card">
                  <div className="card-head">
                    <h2>最近会话</h2>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenSessions}>全部会话</button>
                  </div>
                  <div className="card-body">
                    {home.recentSessions.length === 0 ? <p className="muted">暂无会话</p> : (
                      <table className="table">
                        <thead><tr><th>会话</th><th>视角</th><th>状态</th></tr></thead>
                        <tbody>
                          {home.recentSessions.map((session) => (
                            <tr key={session.id}>
                              <td className="mono">{session.id.slice(0, 18)}</td>
                              <td><span className="badge badge-neutral">{session.roleView}</span></td>
                              <td>{session.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </section>

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

              <div className="stack">
                <section className="card">
                  <div className="card-head"><h2>租户运行健康</h2><span className="badge badge-ok">正常</span></div>
                  <div className="card-body">
                    <div className="health-row">
                      <div className="row-between"><span className="muted">连接器配置</span><span className="mono">{home.metrics.connectors} / 9</span></div>
                      <div className="health-bar"><span style={{ width: `${Math.min(100, Math.round((home.metrics.connectors / 9) * 100))}%` }} /></div>
                    </div>
                    <div className="health-row">
                      <div className="row-between"><span className="muted">场景</span><span className="mono">{home.metrics.scenarios}</span></div>
                      <div className="health-bar is-green"><span style={{ width: `${Math.min(100, home.metrics.scenarios * 10)}%` }} /></div>
                    </div>
                    <div className="health-row">
                      <div className="row-between"><span className="muted">待审批</span><span className="mono">{home.metrics.pendingApprovals}</span></div>
                      <div className="health-bar is-amber"><span style={{ width: `${Math.min(100, home.metrics.pendingApprovals * 12)}%` }} /></div>
                    </div>
                    <div className="aside-row" style={{ marginTop: 12 }}><span>进行中会话</span><span className="mono">{home.metrics.activeSessions}</span></div>
                    <div className="aside-row"><span>活跃长任务</span><span className="mono">{home.metrics.tasksActive}</span></div>
                    <div className="aside-row"><span>未读消息</span><span className="mono">{home.metrics.messagesUnread}</span></div>
                    <div className="aside-row"><span>当前视角</span><span>{home.roleView}</span></div>
                  </div>
                </section>

                <section className="card">
                  <div className="card-head"><h2>快速指令</h2></div>
                  <div className="card-body stack-sm">
                    <button type="button" className="quick-action" onClick={onStartSession}><svg><use href="/icons.svg#i-message" /></svg>开始新会话</button>
                    <button type="button" className="quick-action" onClick={onOpenScenarios}><svg><use href="/icons.svg#i-bolt" /></svg>运行场景</button>
                    <button type="button" className="quick-action" onClick={onOpenConnectors}><svg><use href="/icons.svg#i-plug" /></svg>接入连接器</button>
                    <button type="button" className="quick-action" onClick={onOpenHelp}><svg><use href="/icons.svg#i-book" /></svg>查看用户手册</button>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </main>
      </section>
    </div>
  );
}
