import { useEffect, useState } from 'react';
import { listAudit, type AuditEventSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { formatTime, shortId } from '../format.js';

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
      actions={<a className="btn btn-outline" href="/api/audit/export" download>导出 CSV</a>}
    >
        {error ? <p role="alert">{error}</p> : null}
        <div className="status-strip" style={{ marginBottom: 18 }}>
          <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>审计事件</strong><span>{events?.length ?? 0} 条</span></div></div>
          <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>成功</strong><span>{events?.filter((event) => event.result === 'success').length ?? 0} 条</span></div></div>
          <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>失败</strong><span>{events?.filter((event) => event.result !== 'success').length ?? 0} 条</span></div></div>
          <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-grid" /></svg></span><div><strong>动作类型</strong><span>{new Set((events ?? []).map((event) => event.action)).size} 类</span></div></div>
        </div>
        <div className="card">
          <div className="card-body">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="audit-action">动作</label>
                <input id="audit-action" value={action} onChange={(event) => setAction(event.target.value)} placeholder="例如 auth.login" />
              </div>
              <div className="field">
                <label htmlFor="audit-result">结果</label>
                <input id="audit-result" value={result} onChange={(event) => setResult(event.target.value)} placeholder="success / failure" />
              </div>
            </div>
            <div className="form-actions">
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
                      <td className="mono">{formatTime(event.createdAt)}</td>
                      <td>{event.action}</td>
                      <td>{event.result}</td>
                      <td className="mono" title={event.actorId ?? ''}>{shortId(event.actorId ?? '—', 10)}</td>
                      <td className="mono" title={event.resource ?? ''}>{shortId(event.resource ?? '—', 18)}</td>
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
