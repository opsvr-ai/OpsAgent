import { useEffect, useState } from 'react';
import { listSessions, type SessionSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { relativeTime } from '../format.js';

export interface SessionsProps {
  readonly onBack: () => void;
}

export function Sessions({ onBack }: SessionsProps) {
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
      subtitle="当前租户下我的智能体会话。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="status-strip" style={{ marginBottom: 18 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-message" /></svg></span><div><strong>会话总数</strong><span>{sessions?.length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>进行中</strong><span>{sessions?.filter((session) => session.status === 'active').length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已结束</strong><span>{sessions?.filter((session) => session.status !== 'active').length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-users" /></svg></span><div><strong>角色视角</strong><span>{new Set((sessions ?? []).map((session) => session.roleView)).size} 种</span></div></div>
      </div>
      {sessions === null ? <p className="muted">加载中…</p> : null}
      {sessions?.length === 0 ? (
        <section className="card">
          <div className="card-body empty-state">
            <span className="icon-tile is-blue"><svg><use href="/icons.svg#i-message" /></svg></span>
            <h3>暂无会话</h3>
            <p className="muted">从工作台新建会话后会出现在这里。</p>
          </div>
        </section>
      ) : null}
      {sessions && sessions.length > 0 ? (
        <section className="card">
          <div className="card-head"><h2>全部会话</h2><span className="muted">最近 100 条</span></div>
          <div className="card-body">
            <table className="table">
              <thead><tr><th>会话</th><th>状态</th><th>角色视角</th><th>创建时间</th></tr></thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="mono">{session.id.slice(0, 18)}</td>
                    <td><span className="badge badge-neutral">{session.status}</span></td>
                    <td>{session.roleView}</td>
                    <td className="mono">{relativeTime(session.createdAt)}</td>
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
