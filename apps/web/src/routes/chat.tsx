import { useRef, useState, type FormEvent } from 'react';
import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PermissionMode } from '@opsagent/contracts';
import type { ApprovalRequestEvent, RuntimeEvent } from '@opsagent/contracts';
import {
  decideApproval,
  getSessionTranscript,
  listApprovals,
  listSessions,
  promptSession,
  type ApprovalSummary,
  type SessionSummary,
} from '../api/client.js';
import { relativeTime } from '../format.js';
import { AppSidebar } from './app-sidebar.js';
import { GlobalSearch } from './global-search.js';
import { ThemeToggle } from '../theme/use-theme.js';
import { useSession } from '../session-context.js';

export interface ChatProps {
  readonly sessionId: string;
  readonly roleView: string;
  readonly onBack: () => void;
  readonly onOpenSession: (id: string) => void;
  readonly onNewSession: () => void;
}

type ChatTimelineEntry =
  | { readonly kind: 'user'; readonly id: string; readonly text: string; readonly at?: string }
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

export function Chat({ sessionId, roleView, onBack, onOpenSession, onNewSession }: ChatProps) {
  const session = useSession();
  const [timeline, setTimeline] = useState<ChatTimelineEntry[]>([]);
  const events = timeline.filter((entry): entry is { kind: 'event'; event: RuntimeEvent } => entry.kind === 'event').map((entry) => entry.event);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
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
    let active = true;
    setLoadingTranscript(true);
    setTimeline([]);
    setError(null);
    void getSessionTranscript(sessionId)
      .then((items) => {
        if (!active) return;
        setTimeline(items.map((item) => item.kind === 'user'
          ? { kind: 'user' as const, id: item.id, text: item.text, at: item.at }
          : { kind: 'event' as const, event: item.event }));
      })
      .catch(() => {
        if (active) setError('会话历史加载失败');
      })
      .finally(() => {
        if (active) setLoadingTranscript(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!historyOpen) return;
    setSessions(null);
    setHistoryError(null);
    void listSessions()
      .then(setSessions)
      .catch(() => setHistoryError('会话历史加载失败'));
  }, [historyOpen]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [timeline, busy, runtimeApprovals.length, expandedApproval]);

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
    setTimeline((current) => [...current, { kind: 'user', id: crypto.randomUUID(), text, at: new Date().toISOString() }]);
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
    if (item.type === 'tool.call' && item.tool.startsWith('opsagent.')) {
      const label = item.tool === 'opsagent.fleet'
        ? '纳管智能体清单'
        : item.tool === 'opsagent.alerts'
          ? '主动发现告警'
          : item.tool === 'opsagent.agent_snapshot'
            ? '主机配置与性能快照'
            : '主机命令下发';
      return (
        <div key={index} className="msg platform-tool-msg">
          <span className="msg-avatar is-agent"><svg><use href="/icons.svg#i-shield" /></svg></span>
          <div className="msg-body">
            <div className="platform-tool-line">
              <span className="platform-tool-copy"><strong>平台数据查询</strong><small>{label}</small></span>
              <span className="badge badge-ok">{item.tool === 'opsagent.agent_command' ? '已下发' : '已读取'}</span>
            </div>
          </div>
        </div>
      );
    }
    if (item.type === 'tool.result' && item.tool.startsWith('opsagent.')) {
      return null;
    }
    if (item.type === 'assistant.delta') {
      return (
        <div key={index} className="msg">
          <span className="msg-avatar is-agent">A</span>
          <div className="msg-body">
            <div className="msg-meta"><strong>OpsAgent</strong><span className="badge badge-neutral">{item.source === 'platform' ? '平台数据' : 'deepseek-flash'}</span><span>{relativeTime(item.at)}</span></div>
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
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setHistoryOpen(true)} disabled={busy}>
                  <svg><use href="/icons.svg#i-history" /></svg>
                  历史
                </button>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void navigator.clipboard?.writeText(sessionId)}>复制会话 ID</button>
              </div>
            </header>

            <div className="chat-log" ref={logRef}>
              <div className="chat-inner" aria-live="polite">
                {error ? <p role="alert">{error}</p> : null}
                {loadingTranscript ? (
                  <div className="chat-loading"><span className="dot dot-warn" />正在加载会话历史…</div>
                ) : timeline.length === 0 ? (
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
                      <div className="msg-meta"><strong>{session?.me.user.displayName ?? '我'}</strong><span>{entry.at ? relativeTime(entry.at) : '刚刚'}</span></div>
                      <div className="msg-text"><p>{entry.text}</p></div>
                    </div>
                  </div>
                ) : renderEvent(entry.event, index))}
                {runtimeApprovals.length > 0 ? (
                  <div className="approval-stack">
                    {runtimeApprovals.map((approval) => {
                      const details = approval.details as Record<string, unknown>;
                      const command = typeof details.command === 'string' ? details.command : null;
                      const description = typeof details.description === 'string' ? details.description : null;
                      const expanded = expandedApproval === approval.id;
                      const highRisk = approval.risk === 'R3';
                      return (
                        <section key={approval.id} className={`approval-card${expanded ? ' is-expanded' : ''}`} aria-label="执行审批">
                          <div className="approval-card-head">
                            <span className={`approval-symbol${highRisk ? ' is-high' : ''}`}><svg><use href="/icons.svg#i-shield" /></svg></span>
                            <div className="approval-heading">
                              <div className="eyebrow">执行审批 · dsh 已暂停</div>
                              <h3>{description || '允许执行此操作？'}</h3>
                              <p>{approval.action} 请求在 <strong>{permissionLabel(permissionMode)}</strong> 权限下执行</p>
                            </div>
                            <span className="approval-time">{new Date(approval.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          {command ? (
                            <div className="approval-terminal">
                              <div className="approval-terminal-bar">
                                <span className="approval-terminal-dots"><i /><i /><i /></span>
                                <span className="approval-terminal-title">bash</span>
                                {command.length > 220 ? (
                                  <button type="button" className="approval-terminal-action" onClick={() => setExpandedApproval(expanded ? null : approval.id)}>
                                    {expanded ? '收起' : '展开'}
                                  </button>
                                ) : null}
                              </div>
                              <pre>{command}</pre>
                            </div>
                          ) : null}
                          <div className="approval-facts">
                            <div><span>工具</span><strong>{approval.action}</strong></div>
                            <div><span>风险</span><strong className={highRisk ? 'is-high' : 'is-warn'}>{highRisk ? '高' : '中'}风险 · {approval.risk}</strong></div>
                            <div><span>权限</span><strong>{permissionLabel(permissionMode)}</strong></div>
                            <div><span>生效范围</span><strong>仅本次调用</strong></div>
                          </div>
                          <div className="approval-card-foot">
                            <p>批准后命令立即执行；拒绝后 dsh 会收到拒绝结果。</p>
                            <div className="approval-card-actions">
                              <button type="button" className="btn btn-outline" onClick={() => void decideRuntime(approval.id, 'deny')}>拒绝</button>
                              <button type="button" className="btn btn-primary" onClick={() => void decideRuntime(approval.id, 'approve')}>批准并执行</button>
                            </div>
                          </div>
                        </section>
                      );
                    })}
                  </div>
                ) : null}
                {busy ? <div className="chat-thinking"><span className="dot dot-warn" />思考中…</div> : null}
              </div>
            </div>


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
                  disabled={busy || loadingTranscript}
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
                  <button className="send" type="submit" disabled={busy || loadingTranscript} aria-label="发送">
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
                  .filter((item) => (item.type === 'tool.call' || item.type === 'tool.result' || item.type === 'approval.request')
                    && !(item.type === 'tool.result' && item.tool.startsWith('opsagent.')))
                  .slice(-6)
                  .map((item, index) => {
                    const toolName = item.type === 'tool.call' || item.type === 'tool.result' ? item.tool : '';
                    const trajectoryLabel = item.type === 'approval.request'
                      ? '审批请求'
                      : item.type === 'tool.result'
                        ? '工具返回'
                        : toolName.startsWith('opsagent.')
                          ? '平台数据查询'
                          : `工具调用 · ${toolName}`;
                    return (
                      <div key={index} className="aside-row">
                        <span>{trajectoryLabel}</span>
                        <span className={`badge ${item.type === 'approval.request' ? 'badge-warn' : item.type === 'tool.result' ? 'badge-ok' : 'badge-neutral'}`}>
                          {item.type === 'approval.request' ? '待确认' : item.type === 'tool.result' ? '完成' : '已发起'}
                        </span>
                      </div>
                    );
                  })}
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

      {historyOpen ? (
        <div className="history-overlay" onClick={() => setHistoryOpen(false)}>
          <aside className="history-drawer" aria-label="会话历史" onClick={(event) => event.stopPropagation()}>
            <header className="history-head">
              <div>
                <div className="eyebrow">History</div>
                <h2>会话历史</h2>
              </div>
              <button type="button" className="topbar-icon" aria-label="关闭会话历史" onClick={() => setHistoryOpen(false)}>
                <svg><use href="/icons.svg#i-x" /></svg>
              </button>
            </header>
            <button type="button" className="history-new" onClick={() => { setHistoryOpen(false); onNewSession(); }}>
              <svg><use href="/icons.svg#i-plus" /></svg>
              新对话
            </button>
            <div className="history-list">
              {historyError ? <p role="alert">{historyError}</p> : null}
              {sessions === null && !historyError ? <p className="muted history-loading">加载中…</p> : null}
              {sessions?.length === 0 ? <p className="muted history-loading">还没有历史会话</p> : null}
              {sessions?.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`history-item${item.id === sessionId ? ' is-active' : ''}`}
                  aria-current={item.id === sessionId ? 'true' : undefined}
                  onClick={() => {
                    setHistoryOpen(false);
                    if (item.id !== sessionId) onOpenSession(item.id);
                  }}
                >
                  <span className="history-item-top">
                    <strong>{item.title || '新会话'}</strong>
                    <span className={`badge ${item.status === 'active' ? 'badge-ok' : 'badge-neutral'}`}>
                      {item.status === 'active' ? '进行中' : item.status === 'failed' ? '失败' : '已结束'}
                    </span>
                  </span>
                  <span className="history-item-meta">
                    <span>{relativeTime(item.lastActivityAt)}</span>
                    <span>{item.messageCount} 条记录</span>
                    <span>{item.roleView}</span>
                  </span>
                  <span className="mono history-item-id">{item.id.slice(0, 12)}</span>
                </button>
              ))}
            </div>
            <p className="history-foot">点击历史会话即可恢复聊天记录并继续对话。</p>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
