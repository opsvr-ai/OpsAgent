import { useEffect, useState } from 'react';
import { listSessions, type SessionSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { relativeTime } from '../format.js';

export interface SessionsProps {
  readonly onBack: () => void;
  readonly onOpenSession: (id: string) => void;
}

function statusLabel(status: string): string {
  if (status === 'active') return '进行中';
  if (status === 'failed') return '失败';
  return '已结束';
}

export function Sessions({ onBack, onOpenSession }: SessionsProps) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listSessions()
      .then(setSessions)
      .catch(() => setError('会话历史加载失败'));
  }, []);

  return (
    <DesignShell
      active="sessions"
      eyebrow="Sessions"
      title="会话历史"
      subtitle="当前租户下我的智能体会话；打开任意会话即可查看记录并继续对话。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="status-strip" style={{ marginBottom: 18 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-message" /></svg></span><div><strong>会话总数</strong><span>{sessions?.length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>进行中</strong><span>{sessions?.filter((session) => session.status === 'active').length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已结束</strong><span>{sessions?.filter((session) => session.status !== 'active').length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-users" /></svg></span><div><strong>角色视角</strong><span>{new Set((sessions ?? []).map((session) => session.roleView)).size} 种</span></div></div>
      </div>
      {sessions === null && !error ? <p className="muted">加载中…</p> : null}
      {sessions?.length === 0 ? (
        <section className="card">
          <div className="card-body empty-state">
            <span className="icon-tile is-blue"><svg><use href="/icons.svg#i-message" /></svg></span>
            <h3>暂无会话</h3>
            <p className="muted">从工作台新建会话后，会出现在这里。</p>
          </div>
        </section>
      ) : null}
      {sessions && sessions.length > 0 ? (
        <section className="card">
          <div className="card-head"><h2>全部会话</h2><span className="muted">最近 50 条</span></div>
          <div className="card-body">
            <table className="table">
              <thead><tr><th>会话</th><th>状态</th><th>记录</th><th>角色视角</th><th>最近活动</th><th /></tr></thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <button type="button" className="link-button" onClick={() => onOpenSession(session.id)}>
                        {session.title || '新会话'}
                      </button>
                      <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>{session.id.slice(0, 12)}</div>
                    </td>
                    <td><span className={`badge ${session.status === 'active' ? 'badge-ok' : 'badge-neutral'}`}>{statusLabel(session.status)}</span></td>
                    <td className="mono">{session.messageCount}</td>
                    <td>{session.roleView}</td>
                    <td className="mono">{relativeTime(session.lastActivityAt)}</td>
                    <td><button type="button" className="btn btn-outline btn-sm" onClick={() => onOpenSession(session.id)}>打开</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </DesignShell>
  );
}
