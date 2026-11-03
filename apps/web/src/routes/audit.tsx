import { useEffect, useState } from 'react';
import { listAudit, type AuditEventSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface AuditProps {
  readonly onBack: () => void;
}

export function Audit({ onBack }: AuditProps) {
  const [events, setEvents] = useState<AuditEventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');

  async function load() {
    setError(null);
    try {
      setEvents(
        await listAudit(100, {
          ...(action ? { action } : {}),
          ...(result ? { result } : {}),
        }),
      );
    } catch {
      setError('审计加载失败');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <DesignShell
      active="audit"
      eyebrow="Audit"
      title="审计事件"
      subtitle="最近 100 条租户审计记录，工具调用与审批决策均不可篡改。"
      onBack={onBack}
    >
        <div className="row-sm" style={{ marginBottom: 16 }}>
          <a className="btn btn-outline" href="/api/audit/export" download>导出 CSV</a>
        </div>
        <div className="card">
          <div className="card-body">
            <div className="row-sm">
              <label htmlFor="audit-action">动作</label>
              <input id="audit-action" value={action} onChange={(event) => setAction(event.target.value)} />
              <label htmlFor="audit-result">结果</label>
              <input id="audit-result" value={result} onChange={(event) => setResult(event.target.value)} />
              <button type="button" className="btn btn-primary" onClick={() => void load()}>筛选</button>
            </div>
          </div>
        </div>
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
