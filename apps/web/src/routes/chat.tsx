import { useState, type FormEvent } from 'react';
import { useEffect } from 'react';
import type { ApprovalRequestEvent, RuntimeEvent } from '@opsagent/contracts';
import {
  decideApproval,
  listApprovals,
  promptSession,
  type ApprovalSummary,
} from '../api/client.js';
import { NAV } from './design-shell.js';
import { GlobalSearch } from './global-search.js';
import { ThemeToggle } from '../theme/use-theme.js';
import { useSession } from '../session-context.js';

export interface ChatProps {
  readonly sessionId: string;
  readonly roleView: string;
  readonly onBack: () => void;
}

export function Chat({ sessionId, roleView, onBack }: ChatProps) {
  const session = useSession();
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequestEvent | null>(null);
  const [runtimeApprovals, setRuntimeApprovals] = useState<ApprovalSummary[]>([]);

  useEffect(() => {
    if (!busy) {
      setRuntimeApprovals([]);
      return;
    }
    const timer = setInterval(() => {
      void listApprovals()
        .then(setRuntimeApprovals)
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [busy]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const text = input;
    setInput('');
    setBusy(true);
    try {
      for await (const item of promptSession(sessionId, text, crypto.randomUUID())) {
        setEvents((current) => [...current, item]);
        if (item.type === 'approval.request') setPendingApproval(item);
        if (item.type === 'session.done') setBusy(false);
      }
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!pendingApproval) return;
    await decideApproval(pendingApproval.approvalId, decision);
    setPendingApproval(null);
  }

  async function decideRuntime(id: string, decision: 'approve' | 'deny') {
    await decideApproval(id, decision);
    setRuntimeApprovals((current) => current.filter((item) => item.id !== id));
  }

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
          <span className="avatar">会</span>
          <span className="tenant-meta">
            <strong>智能体会话</strong>
            <span>{roleView}</span>
          </span>
        </button>
        <nav className="nav">
          <div className="nav-group">
            <div className="nav-label">工作空间</div>
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item${item.id === 'sessions' ? ' is-active' : ''}`}
                onClick={() => {
                  if (item.id === 'home') {
                    onBack();
                    return;
                  }
                  window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: item.id }));
                }}
              >
                <svg><use href={`/icons.svg#i-${item.icon}`} /></svg>
                <span>{item.label}</span>
                {item.id === 'messages' && (session?.home?.metrics.messagesUnread ?? 0) > 0 ? (
                  <span className="nav-badge is-alert">{session?.home?.metrics.messagesUnread}</span>
                ) : null}
                {item.id === 'approvals' && (session?.home?.metrics.pendingApprovals ?? 0) > 0 ? (
                  <span className="nav-badge is-alert">{session?.home?.metrics.pendingApprovals}</span>
                ) : null}
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="logout-link" onClick={() => window.dispatchEvent(new Event('opsagent:logout'))}>退出登录</button>
        </div>
      </aside>

      <section className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>智能体会话</span>
            <span className="sep">/</span>
            <span className="current mono">{sessionId.slice(0, 18)}</span>
          </div>
          <div className="topbar-spacer" />
          <GlobalSearch />
          <ThemeToggle />
          <button type="button" className="topbar-icon" aria-label="消息中心" onClick={() => window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'messages' }))}><svg><use href="/icons.svg#i-bell" /></svg>{(session?.home?.metrics.messagesUnread ?? 0) > 0 ? <span className="topbar-badge">{session?.home?.metrics.messagesUnread}</span> : null}</button>
          <button type="button" className="topbar-icon" aria-label="待审批" onClick={() => window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'approvals' }))}><svg><use href="/icons.svg#i-check" /></svg>{(session?.home?.metrics.pendingApprovals ?? 0) > 0 ? <span className="topbar-badge">{session?.home?.metrics.pendingApprovals}</span> : null}</button>
          <span className="env-pill"><span className="dot dot-ok" style={{ width: 5, height: 5 }} />{roleView}</span>
        </header>

        <main className="chat-layout">
          <div className="chat-main">
            <header className="chat-head">
              <div>
                <div className="eyebrow">Session · {roleView}</div>
                <h2>运维会话</h2>
              </div>
              <div className="row-sm">
                <span className="badge badge-ok">已连接</span>
                <span className="badge badge-neutral mono">{sessionId.slice(0, 12)}</span>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void navigator.clipboard?.writeText(sessionId)}>复制会话 ID</button>
              </div>
            </header>

            <div className="chat-log">
              <div className="chat-inner" aria-live="polite">
                {events.length === 0 ? (
                  <div className="msg">
                    <div className="msg-body">
                      <div className="msg-meta"><strong>OpsAgent</strong><span>ready</span></div>
                      <div className="msg-text">
                        <p>描述告警、服务或主机问题。R2/R3 操作会先请求审批，所有工具调用写入审计。</p>
                        <div className="chat-suggestions">
                          {['查看最近告警', '检查订单服务错误率', '解释最近一次变更'].map((suggestion) => (
                            <button key={suggestion} type="button" className="btn btn-outline" onClick={() => setInput(suggestion)}>
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {events.map((item, index) => {
                  if (item.type === 'assistant.delta') {
                    return (
                      <div key={index} className="msg">
                        <div className="msg-body">
                          <div className="msg-meta"><strong>OpsAgent</strong><span>assistant</span></div>
                          <div className="msg-text"><p>{item.text}</p></div>
                        </div>
                      </div>
                    );
                  }
                  if (item.type === 'tool.call') {
                    return (
                      <div key={index} className="msg" data-testid="tool-call">
                        <div className="msg-body">
                          <div className="tool-card">
                            <div className="tool-head">
                              <span className="icon-tile is-blue"><svg><use href="/icons.svg#i-bolt" /></svg></span>
                              <strong>{item.tool}</strong>
                              <span className="badge badge-neutral">{item.risk} · 调用</span>
                            </div>
                            <pre className="tool-code">{JSON.stringify(item.args, null, 2)}</pre>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  if (item.type === 'tool.result') {
                    return (
                      <div key={index} className="msg">
                        <div className="msg-body">
                          <div className="tool-card is-result">
                            <div className="tool-head">
                              <span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span>
                              <strong>{item.tool}</strong>
                              <span className="badge badge-ok">已返回</span>
                            </div>
                            <pre className="tool-code">{JSON.stringify(item.result, null, 2)}</pre>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  if (item.type === 'approval.request') {
                    return (
                      <div key={index} className="approval-card">
                        <div className="tool-head">
                          <span className="icon-tile is-amber"><svg><use href="/icons.svg#i-shield" /></svg></span>
                          <div className="grow">
                            <div className="eyebrow">需要审批 · {item.risk}</div>
                            <strong>{item.action}</strong>
                          </div>
                        </div>
                        <p className="muted">该操作需要人工确认；批准后当前 dsh 会话继续执行，拒绝则终止该工具调用。</p>
                        <div className="row-sm">
                          <button type="button" className="btn btn-primary" onClick={() => void decide('approve')}>批准</button>
                          <button type="button" className="btn btn-outline" onClick={() => void decide('deny')}>拒绝</button>
                        </div>
                      </div>
                    );
                  }
                  if (item.type === 'session.done') {
                    return <p key={index} className="muted" style={{ textAlign: 'center' }}>完成</p>;
                  }
                  return <p key={index} role="alert">运行时错误：{item.code}</p>;
                })}
              </div>
            </div>

            {runtimeApprovals.length > 0 ? (
              <div className="card" style={{ margin: '8px 24px' }}>
                <div className="card-body">
                  <div className="eyebrow">运行时审批</div>
                  {runtimeApprovals.map((approval) => (
                    <div key={approval.id} className="row-between">
                      <span>{approval.action} · {approval.risk}</span>
                      <span className="row-sm">
                        <button type="button" className="btn btn-primary" onClick={() => void decideRuntime(approval.id, 'approve')}>批准</button>
                        <button type="button" className="btn btn-outline" onClick={() => void decideRuntime(approval.id, 'deny')}>拒绝</button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="composer-wrap">
              <form className="composer" onSubmit={send}>
                <label htmlFor="prompt" className="eyebrow">输入</label>
                <textarea
                  id="prompt"
                  rows={3}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  disabled={busy}
                  placeholder="例如：订单服务 5xx 升高，先确认数据库连接池与最近变更"
                />
                <div className="composer-bar">
                  <span className="composer-hint">工具调用受租户与角色约束</span>
                  <button className="btn btn-primary" type="submit" disabled={busy}>发送</button>
                </div>
              </form>
            </div>
          </div>
          <aside className="chat-aside">
            <div className="aside-block">
              <div className="eyebrow">运行轨迹</div>
              <div className="stack-sm" style={{ marginTop: 10 }}>
                {events.length === 0 ? <p className="muted">等待第一条指令</p> : null}
                {events
                  .filter((item) => item.type === 'tool.call' || item.type === 'tool.result' || item.type === 'approval.request')
                  .slice(-6)
                  .map((item, index) => (
                    <div key={index} className="aside-row">
                      <span>{item.type === 'approval.request' ? '审批请求' : item.type === 'tool.result' ? '工具返回' : `工具调用 · ${item.tool}`}</span>
                      <span className={`badge ${item.type === 'approval.request' ? 'badge-warn' : 'badge-ok'}`}>
                        {item.type === 'approval.request' ? '待确认' : '完成'}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
            <div className="aside-block">
              <div className="eyebrow">当前会话</div>
              <div className="stack-sm" style={{ marginTop: 10 }}>
                <div className="aside-row"><span>会话</span><span className="mono">{sessionId.slice(0, 12)}</span></div>
                <div className="aside-row"><span>角色视角</span><span>{roleView}</span></div>
                <div className="aside-row"><span>状态</span><span>{busy ? '运行中' : '空闲'}</span></div>
              </div>
            </div>
            <div className="aside-block">
              <div className="eyebrow">待处理</div>
              <p className="muted">{runtimeApprovals.length} 个运行时审批</p>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'approvals' }))}>打开审批中心</button>
            </div>
            <div className="aside-block">
              <div className="eyebrow">安全边界</div>
              <p className="muted">工具调用受租户、角色与风险等级约束；R2/R3 必须审批。</p>
            </div>
          </aside>
        </main>
      </section>
    </div>
  );
}
