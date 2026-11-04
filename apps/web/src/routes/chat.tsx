import { useRef, useState, type FormEvent } from 'react';
import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PermissionMode } from '@opsagent/contracts';
import type { ApprovalRequestEvent, RuntimeEvent } from '@opsagent/contracts';
import {
  decideApproval,
  listApprovals,
  promptSession,
  type ApprovalSummary,
} from '../api/client.js';
import { AppSidebar } from './app-sidebar.js';
import { GlobalSearch } from './global-search.js';
import { ThemeToggle } from '../theme/use-theme.js';
import { useSession } from '../session-context.js';

export interface ChatProps {
  readonly sessionId: string;
  readonly roleView: string;
  readonly onBack: () => void;
}

type ChatTimelineEntry =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'event'; readonly event: RuntimeEvent };

const PERMISSION_OPTIONS: ReadonlyArray<{
  readonly id: PermissionMode;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  readonly tag?: string;
}> = [
  { id: 'read-only', label: '仅可查看', description: '只读沙箱，禁止写入文件', icon: 'i-eye' },
  { id: 'workspace-write', label: '工作区内修改', description: '可修改工作区，工作区外只读', icon: 'i-lock' },
  { id: 'danger-full-access', label: '完全权限', description: '跳过审批，可执行任意命令', icon: 'i-shield' },
  { id: 'auto-review', label: '自动审查', description: '只读操作自动放行，写操作询问', icon: 'i-bolt', tag: 'EXP' },
];

function permissionLabel(mode: PermissionMode): string {
  return PERMISSION_OPTIONS.find((option) => option.id === mode)?.label ?? mode;
}

export function Chat({ sessionId, roleView, onBack }: ChatProps) {
  const session = useSession();
  const [timeline, setTimeline] = useState<ChatTimelineEntry[]>([]);
  const events = timeline.filter((entry): entry is { kind: 'event'; event: RuntimeEvent } => entry.kind === 'event').map((entry) => entry.event);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequestEvent | null>(null);
  const [runtimeApprovals, setRuntimeApprovals] = useState<ApprovalSummary[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('danger-full-access');
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [expandedApproval, setExpandedApproval] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!permissionOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.permission-picker')) setPermissionOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [permissionOpen]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [timeline, busy]);

  useEffect(() => {
    if (!busy) {
      setRuntimeApprovals([]);
      return;
    }
    const timer = setInterval(() => {
      void listApprovals(sessionId)
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
    setError(null);
    setTimeline((current) => [...current, { kind: 'user', id: crypto.randomUUID(), text }]);
    try {
      for await (const item of promptSession(sessionId, text, crypto.randomUUID(), permissionMode)) {
        setTimeline((current) => [...current, { kind: 'event', event: item }]);
        if (item.type === 'approval.request') setPendingApproval(item);
        if (item.type === 'session.done') setBusy(false);
      }
    } catch {
      setError('会话请求失败，请检查模型配置或运行时状态');
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

  function renderEvent(item: RuntimeEvent, index: number) {
    if (item.type === 'assistant.delta') {
      return (
        <div key={index} className="msg">
          <span className="msg-avatar is-agent">A</span>
          <div className="msg-body">
            <div className="msg-meta"><strong>OpsAgent</strong><span className="badge badge-neutral">deepseek-flash</span><span>刚刚</span></div>
            <div className="msg-text markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown></div>
          </div>
        </div>
      );
    }
    if (item.type === 'tool.call') {
      return (
        <div key={index} className="msg" data-testid="tool-call">
          <span className="msg-avatar is-tool"><svg><use href="/icons.svg#i-bolt" /></svg></span>
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
      const output = typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2);
      return (
        <div key={index} className="msg">
          <span className="msg-avatar is-tool is-ok"><svg><use href="/icons.svg#i-check" /></svg></span>
          <div className="msg-body">
            <div className="tool-card is-result">
              <div className="tool-head">
                <span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span>
                <strong>{item.tool}</strong>
                <span className="badge badge-ok">已返回</span>
              </div>
              <pre className="tool-output">{output}</pre>
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
          <div className="aside-row"><span>审批 ID</span><span className="mono">{item.approvalId.slice(0, 12)}</span></div>
          <div className="aside-row"><span>操作</span><span className="mono">{item.action}</span></div>
          <div className="aside-row"><span>范围</span><span>当前会话 · 租户内</span></div>
          <div className="aside-row"><span>风险</span><span>{item.risk}</span></div>
          <div className="row-sm">
            <button type="button" className="btn btn-primary" onClick={() => void decide('approve')}>批准</button>
            <button type="button" className="btn btn-outline" onClick={() => void decide('deny')}>拒绝</button>
          </div>
        </div>
      );
    }
    if (item.type === 'session.done') {
      return <div key={index} className="session-done"><span />完成</div>;
    }
    return <p key={index} role="alert">运行时错误：{item.code}</p>;
  }

  return (
    <div className="app">
      <AppSidebar active="chat" onHome={onBack} />

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
                <h1>运维会话</h1>
              </div>
              <div className="row-sm">
                <span className="badge badge-ok">已连接</span>
                <span className="badge badge-neutral mono">{sessionId.slice(0, 12)}</span>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void navigator.clipboard?.writeText(sessionId)}>复制会话 ID</button>
              </div>
            </header>

            <div className="chat-log" ref={logRef}>
              <div className="chat-inner" aria-live="polite">
                {error ? <p role="alert">{error}</p> : null}
                {timeline.length === 0 ? (
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
                {timeline.map((entry, index) => entry.kind === 'user' ? (
                  <div key={entry.id} className="msg msg-user">
                    <span className="msg-avatar is-user">{session?.me.user.displayName?.slice(0, 1) ?? '我'}</span>
                    <div className="msg-body">
                      <div className="msg-meta"><strong>{session?.me.user.displayName ?? '我'}</strong><span>刚刚</span></div>
                      <div className="msg-text"><p>{entry.text}</p></div>
                    </div>
                  </div>
                ) : renderEvent(entry.event, index))}
                {busy ? <div className="chat-thinking"><span className="dot dot-warn" />思考中…</div> : null}
              </div>
            </div>

            {runtimeApprovals.length > 0 ? (
              <div className="approval-queue">
                <div className="approval-queue-head">
                  <span className="approval-shield"><svg><use href="/icons.svg#i-shield" /></svg></span>
                  <div className="grow">
                    <strong>等待你的审批</strong>
                    <span>{runtimeApprovals.length} 个操作暂停执行 · {permissionLabel(permissionMode)}</span>
                  </div>
                  <span className="approval-dsh-wait"><span className="dot dot-warn" />dsh 正在等待</span>
                </div>
                <div className="approval-queue-list">
                  {runtimeApprovals.map((approval) => {
                    const details = approval.details as Record<string, unknown>;
                    const command = typeof details.command === 'string' ? details.command : null;
                    const description = typeof details.description === 'string' ? details.description : null;
                    const expanded = expandedApproval === approval.id;
                    const highRisk = approval.risk === 'R3';
                    return (
                      <article key={approval.id} className={`approval-item${expanded ? ' is-expanded' : ''}`}>
                        <div className="approval-item-head">
                          <span className={`approval-tool-mark${highRisk ? ' is-high' : ''}`}>
                            <svg><use href="/icons.svg#i-terminal" /></svg>
                          </span>
                          <div className="approval-item-copy">
                            <strong>{description || `${approval.action} 请求执行`}</strong>
                            <span>{approval.action} · {highRisk ? '高风险' : '中风险'} · {permissionLabel(permissionMode)}</span>
                          </div>
                          <span className="approval-time">{new Date(approval.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        {command ? (
                          <div className="approval-command-wrap">
                            <div className="approval-command-head">
                              <span className="mono">$ {approval.action}</span>
                              {command.length > 180 ? (
                                <button
                                  type="button"
                                  className="approval-expand"
                                  onClick={() => setExpandedApproval(expanded ? null : approval.id)}
                                >
                                  {expanded ? '收起' : '展开完整命令'}
                                </button>
                              ) : null}
                            </div>
                            <pre className="approval-command">{command}</pre>
                          </div>
                        ) : null}
                        <div className="approval-item-foot">
                          <span className="approval-scope"><svg><use href="/icons.svg#i-shield" /></svg>批准后仅执行本次调用</span>
                          <div className="approval-actions">
                            <button type="button" className="btn btn-outline" onClick={() => void decideRuntime(approval.id, 'deny')}>拒绝</button>
                            <button type="button" className="btn btn-primary" onClick={() => void decideRuntime(approval.id, 'approve')}>批准执行</button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="composer-wrap">
              <form className="composer" onSubmit={send}>
                <label htmlFor="prompt" className="sr-only">输入</label>
                <textarea
                  id="prompt"
                  rows={2}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  disabled={busy}
                  placeholder="描述告警、服务或主机问题，输入 / 运行场景，@ 引用数据源…"
                />
                <div className="composer-bar">
                  <button type="button" className="composer-plus" title="添加上下文" aria-label="添加上下文">+</button>
                  <div className="permission-picker">
                    <button
                      type="button"
                      className="permission-trigger"
                      onClick={() => setPermissionOpen((open) => !open)}
                      disabled={busy}
                      aria-expanded={permissionOpen}
                      aria-label={`执行权限：${permissionLabel(permissionMode)}`}
                    >
                      <svg><use href={`/icons.svg#${PERMISSION_OPTIONS.find((option) => option.id === permissionMode)?.icon ?? 'i-shield'}`} /></svg>
                      <span>{permissionLabel(permissionMode)}</span>
                      <svg className="permission-chevron" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg>
                    </button>
                    {permissionOpen ? (
                      <div className="permission-menu">
                        <div className="permission-menu-head">执行权限</div>
                        {PERMISSION_OPTIONS.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            className="permission-option"
                            aria-pressed={permissionMode === option.id}
                            onClick={() => {
                              setPermissionMode(option.id);
                              setPermissionOpen(false);
                            }}
                          >
                            <span className="permission-option-icon"><svg><use href={`/icons.svg#${option.icon}`} /></svg></span>
                            <span className="permission-option-copy">
                              <span className="permission-option-label">{option.label}{option.tag ? <em>{option.tag}</em> : null}</span>
                              <small>{option.description}</small>
                            </span>
                            {permissionMode === option.id ? <svg className="permission-check"><use href="/icons.svg#i-check" /></svg> : null}
                          </button>
                        ))}
                        <p className="permission-menu-foot">完全权限会跳过人工审批，仅建议在受信任任务中使用。</p>
                      </div>
                    ) : null}
                  </div>
                  <span className="model-pill"><span className="dot dot-ok" />deepseek-flash</span>
                  <span className="composer-inline-hint">工具调用受租户与角色约束</span>
                  <button className="send" type="submit" disabled={busy} aria-label="发送">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>
                  </button>
                </div>
              </form>
              <div className="composer-hint"><span>Enter 发送 · Shift + Enter 换行</span><span>上下文由 dsh 会话保持</span></div>
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
                      <span className={`badge ${item.type === 'approval.request' ? 'badge-warn' : item.type === 'tool.result' ? 'badge-ok' : 'badge-neutral'}`}>
                        {item.type === 'approval.request' ? '待确认' : item.type === 'tool.result' ? '完成' : '已发起'}
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
