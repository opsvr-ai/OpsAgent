import { useEffect, useState } from 'react';
import {
  createIncident,
  getIncident,
  listIncidents,
  updateIncident,
  type IncidentDetail,
  type IncidentSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { formatTime } from '../format.js';

export interface IncidentsProps {
  readonly onBack: () => void;
}

function eventLabel(type: string): string {
  if (type === 'created') return '事件创建';
  if (type === 'commander_assigned') return '指派指挥官';
  if (type === 'note') return '指挥记录';
  if (type === 'status_changed') return '状态变更';
  return type;
}

function eventDetail(payload: Record<string, unknown>): string {
  const note = payload.note ?? payload.commander ?? payload.to ?? payload.source;
  return typeof note === 'string' ? note : JSON.stringify(payload);
}

export function Incidents({ onBack }: IncidentsProps) {
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('P2');
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    void listIncidents()
      .then((items) => {
        setIncidents(items);
        setSelectedId(items[0]?.id ?? null);
      })
      .catch(() => setError('事件加载失败'));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void getIncident(selectedId)
      .then(setDetail)
      .catch(() => setError('事件详情加载失败'));
  }, [selectedId]);

  async function create() {
    if (!title.trim()) {
      setError('请填写事件标题');
      return;
    }
    setError(null);
    try {
      const incident = await createIncident({ title: title.trim(), severity });
      setIncidents((current) => [incident, ...(current ?? [])]);
      setSelectedId(incident.id);
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
      setDetail((current) => (current ? { ...current, incident: updated } : current));
    } catch {
      setError('状态更新失败');
    }
  }

  const selected = detail?.incident ?? incidents?.find((item) => item.id === selectedId) ?? null;

  function statusActions(incident: IncidentSummary) {
    if (incident.status === 'open') {
      return <button type="button" className="btn btn-primary btn-sm" onClick={() => void advance(incident.id, 'investigating')}>开始排查</button>;
    }
    if (incident.status === 'investigating') {
      return <button type="button" className="btn btn-primary btn-sm" onClick={() => void advance(incident.id, 'mitigated')}>已缓解</button>;
    }
    if (incident.status === 'mitigated') {
      return <button type="button" className="btn btn-primary btn-sm" onClick={() => void advance(incident.id, 'resolved')}>已解决</button>;
    }
    if (incident.status === 'resolved') {
      return <button type="button" className="btn btn-outline btn-sm" onClick={() => void advance(incident.id, 'closed')}>关闭</button>;
    }
    return null;
  }

  return (
    <DesignShell
      active="incidents"
      eyebrow="Commander"
      title="事件指挥"
      subtitle="事件生命周期、指挥官与审计时间线。"
      onBack={onBack}
      actions={<button type="button" className="btn btn-primary" onClick={() => setShowCreate((current) => !current)}>新建事件</button>}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="status-strip" style={{ marginBottom: 20 }}>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>事件总数</strong><span>{incidents?.length ?? 0} 条</span></div></div>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>处理中</strong><span>{incidents?.filter((item) => item.status === 'investigating').length ?? 0} 条</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已解决</strong><span>{incidents?.filter((item) => item.status === 'resolved' || item.status === 'closed').length ?? 0} 条</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-clock" /></svg></span><div><strong>时间线</strong><span>{detail?.events.length ?? 0} 条记录</span></div></div>
      </div>
      {showCreate ? (
      <section className="card">
        <div className="card-head"><h2>新建事件</h2><span className="muted">R2/R3 操作需审批</span></div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="incident-title">标题</label>
              <input id="incident-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 订单服务 5xx 升高" />
            </div>
            <div className="field">
              <label htmlFor="incident-severity">等级</label>
              <select id="incident-severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
                <option value="P0">P0</option>
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void create()}>创建事件</button>
          </div>
        </div>
      </section>
      ) : null}

      {incidents === null ? <p className="muted">加载中…</p> : null}
      {incidents?.length === 0 ? (
        <section className="card">
          <div className="card-body empty-state">
            <span className="icon-tile is-amber"><svg><use href="/icons.svg#i-activity" /></svg></span>
            <h3>暂无事件</h3>
            <p className="muted">创建事件后，状态变更和指挥动作会进入时间线。</p>
          </div>
        </section>
      ) : null}

      {incidents && incidents.length > 0 ? (
        <div className="split-grid incident-grid">
          <section className="card">
            <div className="card-head"><h2>事件</h2><span className="muted">{incidents.length}</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              {incidents.map((incident) => (
                <button
                  key={incident.id}
                  type="button"
                  className={`inbox-item${incident.id === selectedId ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(incident.id)}
                >
                  <span className="badge badge-neutral">{incident.severity}</span>
                  <span className="grow">
                    <strong>{incident.title}</strong>
                    <span>{incident.status}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>{selected?.title ?? '事件详情'}</h2>
              {selected ? <span className="badge badge-neutral">{selected.severity}</span> : null}
            </div>
            <div className="card-body">
              {selected ? (
                <>
                  <div className="row-between" style={{ marginBottom: 12 }}>
                    <span className="badge badge-neutral">{selected.status}</span>
                    <div className="row-sm">{statusActions(selected)}</div>
                  </div>
                  <div className="aside-row"><span>事件 ID</span><span className="mono">{selected.id.slice(0, 18)}</span></div>
                  <div className="aside-row"><span>指挥官</span><span>{selected.commanderId ?? '未指派'}</span></div>
                  <h3 style={{ marginTop: 18 }}>时间线</h3>
                  {detail?.events.length === 0 ? <p className="muted">暂无时间线事件</p> : null}
                  <div className="timeline">
                    {detail?.events.map((event) => (
                      <div key={event.id} className="timeline-item is-done">
                        <div className="t-title">{eventLabel(event.type)}</div>
                        <div className="t-meta">{formatTime(event.createdAt)} · {eventDetail(event.payload)}</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : <p className="muted">选择一条事件</p>}
            </div>
          </section>
        </div>
      ) : null}
    </DesignShell>
  );
}
