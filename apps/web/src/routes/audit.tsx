import { useEffect, useState } from 'react';
import { listAudit, type AuditEventSummary } from '../api/client.js';

export interface AuditProps {
  readonly onBack: () => void;
}

export function Audit({ onBack }: AuditProps) {
  const [events, setEvents] = useState<AuditEventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listAudit(100)
      .then(setEvents)
      .catch(() => setError('审计加载失败'));
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">OpsAgent</div>
        <div className="tenant">
          <strong>审计</strong>
          <span>最近 100 条</span>
        </div>
        <button type="button" onClick={onBack}>返回工作台</button>
      </aside>
      <main className="page">
        <header>
          <div className="eyebrow">Audit</div>
          <h1>审计事件</h1>
        </header>
        {error ? <p role="alert">{error}</p> : null}
        {events === null ? <p className="muted">加载中…</p> : null}
        {events?.length === 0 ? <p className="muted">暂无审计事件</p> : null}
        {events && events.length > 0 ? (
          <table className="table">
            <thead>
              <tr><th>时间</th><th>动作</th><th>结果</th><th>Actor</th><th>资源</th></tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="mono">{event.createdAt}</td>
                  <td>{event.action}</td>
                  <td>{event.result}</td>
                  <td className="mono">{event.actorId ?? '—'}</td>
                  <td className="mono">{event.resource ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </main>
    </div>
  );
}
