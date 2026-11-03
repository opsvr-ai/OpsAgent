import { useEffect, useState } from 'react';
import { listAudit, type AuditEventSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

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
    <DesignShell
      active="audit"
      eyebrow="Audit"
      title="审计事件"
      subtitle="最近 100 条租户审计记录，工具调用与审批决策均不可篡改。"
      onBack={onBack}
    >
        {error ? <p role="alert">{error}</p> : null}
        {events === null ? <p className="muted">加载中…</p> : null}
        {events?.length === 0 ? <p className="muted">暂无审计事件</p> : null}
        {events && events.length > 0 ? (
          <section className="card">
            <div className="card-body">
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
            </div>
          </section>
        ) : null}
    </DesignShell>
  );
}
