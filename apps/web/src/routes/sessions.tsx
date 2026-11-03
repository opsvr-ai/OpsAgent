import { useEffect, useState } from 'react';
import { listSessions, type SessionSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

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
      {sessions === null ? <p className="muted">加载中…</p> : null}
      {sessions?.length === 0 ? <p className="muted">暂无会话</p> : null}
      <section className="grid grid-3">
        {sessions?.map((session) => (
          <article key={session.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="badge badge-neutral">{session.status}</span>
                <span className="muted">{session.roleView}</span>
              </div>
              <h3 className="mono">{session.id.slice(0, 18)}</h3>
              <p className="muted">{session.createdAt}</p>
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
