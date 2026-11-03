import { useEffect, useState } from 'react';
import {
  createIncident,
  listIncidents,
  updateIncident,
  type IncidentSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface IncidentsProps {
  readonly onBack: () => void;
}

export function Incidents({ onBack }: IncidentsProps) {
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('P2');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listIncidents()
      .then(setIncidents)
      .catch(() => setError('事件加载失败'));
  }, []);

  async function create() {
    if (!title.trim()) {
      setError('请填写事件标题');
      return;
    }
    setError(null);
    try {
      const incident = await createIncident({ title: title.trim(), severity });
      setIncidents((current) => [incident, ...(current ?? [])]);
      setTitle('');
    } catch {
      setError('创建失败');
    }
  }

  async function advance(id: string, status: string) {
    setError(null);
    try {
      const updated = await updateIncident(id, { status });
      setIncidents((current) => current?.map((item) => (item.id === id ? updated : item)) ?? current);
    } catch {
      setError('状态更新失败');
    }
  }

  return (
    <DesignShell
      active="incidents"
      eyebrow="Commander"
      title="事件指挥"
      subtitle="事件生命周期、指挥官与审计时间线。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <section className="card">
        <div className="card-body">
          <h2>新建事件</h2>
          <label htmlFor="incident-title">标题</label>
          <input id="incident-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor="incident-severity">等级</label>
          <select id="incident-severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="P0">P0</option>
            <option value="P1">P1</option>
            <option value="P2">P2</option>
            <option value="P3">P3</option>
          </select>
          <button type="button" className="btn btn-primary" onClick={() => void create()}>创建事件</button>
        </div>
      </section>

      {incidents === null ? <p className="muted">加载中…</p> : null}
      {incidents?.length === 0 ? <p className="muted">暂无事件</p> : null}
      <section className="grid grid-3">
        {incidents?.map((incident) => (
          <article key={incident.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="badge badge-neutral">{incident.severity}</span>
                <span className="badge badge-neutral">{incident.status}</span>
              </div>
              <h3>{incident.title}</h3>
              <div className="row-sm">
                {incident.status === 'open' ? (
                  <button type="button" className="btn btn-primary" onClick={() => void advance(incident.id, 'investigating')}>开始排查</button>
                ) : null}
                {incident.status === 'investigating' ? (
                  <button type="button" className="btn btn-primary" onClick={() => void advance(incident.id, 'mitigated')}>已缓解</button>
                ) : null}
                {incident.status === 'mitigated' ? (
                  <button type="button" className="btn btn-primary" onClick={() => void advance(incident.id, 'resolved')}>已解决</button>
                ) : null}
                {incident.status === 'resolved' ? (
                  <button type="button" className="btn btn-outline" onClick={() => void advance(incident.id, 'closed')}>关闭</button>
                ) : null}
              </div>
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
