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
import { ThemeToggle } from '../theme/use-theme.js';

export interface ChatProps {
  readonly sessionId: string;
  readonly roleView: string;
  readonly onBack: () => void;
}

export function Chat({ sessionId, roleView, onBack }: ChatProps) {
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
              </button>
            ))}
          </div>
        </nav>
      </aside>

      <section className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>智能体会话</span>
            <span className="sep">/</span>
            <span className="current mono">{sessionId.slice(0, 18)}</span>
          </div>
          <div className="topbar-spacer" />
          <ThemeToggle />
          <span className="env-pill"><span className="dot dot-ok" style={{ width: 5, height: 5 }} />{roleView}</span>
        </header>

        <main className="chat-layout">
          <div className="chat-main">
            <header className="chat-head">
              <div>
                <div className="eyebrow">Session</div>
                <h2>运维会话</h2>
              </div>
              <span className="badge badge-neutral mono">{sessionId.slice(0, 12)}</span>
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
                          <div className="msg-meta"><strong>{item.tool}</strong><span className="badge badge-neutral">{item.risk} · 调用</span></div>
                          <div className="msg-text"><p>调用参数：{JSON.stringify(item.args)}</p></div>
                        </div>
                      </div>
                    );
                  }
                  if (item.type === 'tool.result') {
                    return (
                      <div key={index} className="msg">
                        <div className="msg-body">
                          <div className="msg-meta"><strong>{item.tool}</strong><span>已返回</span></div>
                          <div className="msg-text"><p>{JSON.stringify(item.result)}</p></div>
                        </div>
                      </div>
                    );
                  }
                  if (item.type === 'approval.request') {
                    return (
                      <div key={index} className="card" style={{ margin: '12px 0' }}>
                        <div className="card-body">
                          <div className="eyebrow">需要审批 · {item.risk}</div>
                          <h3>{item.action}</h3>
                          <div className="row-sm">
                            <button type="button" className="btn btn-primary" onClick={() => void decide('approve')}>批准</button>
                            <button type="button" className="btn btn-outline" onClick={() => void decide('deny')}>拒绝</button>
                          </div>
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
