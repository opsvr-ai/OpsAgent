import { useEffect, useRef, useState } from 'react';
import {
  analyzeIncident,
  createIncident,
  decideIncidentApproval,
  getIncident,
  getIncidentReportTemplate,
  investigateIncident,
  listIncidents,
  listMembers,
  requestIncidentApproval,
  recheckIncident,
  saveIncidentReportTemplate,
  updateIncident,
  type IncidentDetail,
  type IncidentSummary,
  type MemberSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { formatTime } from '../format.js';

export interface IncidentsProps {
  readonly onBack: () => void;
}

function eventLabel(type: string): string {
  if (type === 'created') return '事件创建';
  if (type === 'source_ingested') return '事件源接入';
  if (type === 'source_detected') return 'Agent 异常触发';
  if (type === 'investigation_started') return '自动排障开始';
  if (type === 'investigation_completed') return '自动排障完成';
  if (type === 'connector_evidence') return '连接器证据';
  if (type === 'topology_collected') return '应用系统拓扑聚合';
  if (type === 'approval_requested') return '操作审批申请';
  if (type === 'approval_approved') return '审批通过';
  if (type === 'approval_denied') return '审批拒绝';
  if (type === 'root_cause_converged') return '根因置信度收敛';
  if (type === 'report_generated') return '事件报告已生成';
  if (type === 'auto_resolved') return '异常恢复，事件自动关闭';
  if (type === 'commander_assigned') return '指派指挥官';
  if (type === 'note') return '指挥记录';
  if (type === 'status_changed') return '状态变更';
  return type;
}

function eventDetail(payload: Record<string, unknown>): string {
  if (typeof payload.markdown === 'string') return '报告已生成，可在顶部导出完整 Markdown';
  const note = payload.note ?? payload.commander ?? payload.to ?? payload.source;
  return typeof note === 'string' ? note : JSON.stringify(payload);
}

export function Incidents({ onBack }: IncidentsProps) {
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const detailRequest = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('P2');
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [investigating, setInvestigating] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [analysisText, setAnalysisText] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateBody, setTemplateBody] = useState('');
  const [templateBusy, setTemplateBusy] = useState(false);

  useEffect(() => {
    void listIncidents()
      .then((items) => {
        setIncidents(items);
        setSelectedId(items[0]?.id ?? null);
      })
      .catch(() => setError('事件加载失败'));
    void listMembers()
      .then(setMembers)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const request = ++detailRequest.current;
    void getIncident(selectedId)
      .then((value) => {
        if (request === detailRequest.current) setDetail(value);
      })
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

  async function assignCommander(id: string, commanderId: string) {
    try {
      const updated = await updateIncident(id, { commanderId: commanderId || null });
      setIncidents((current) => current?.map((item) => (item.id === id ? updated : item)) ?? current);
      setDetail((current) => (current ? { ...current, incident: updated } : current));
    } catch {
      setError('指挥官指派失败');
    }
  }

  async function advance(id: string, status: string) {
    detailRequest.current += 1;
    setError(null);
    try {
      const updated = await updateIncident(id, { status });
      setIncidents((current) => current?.map((item) => (item.id === id ? updated : item)) ?? current);
      setDetail((current) => (current ? { ...current, incident: updated } : current));
    } catch {
      setError('状态更新失败');
    }
  }

  async function investigate(id: string) {
    setInvestigating(true);
    setError(null);
    try {
      const next = await investigateIncident(id);
      setDetail(next);
      setIncidents((current) => current?.map((item) => (item.id === id ? next.incident : item)) ?? current);
    } catch {
      setError('自动排障执行失败');
    } finally {
      setInvestigating(false);
    }
  }

  async function requestApproval(id: string) {
    setApprovalBusy(true);
    setError(null);
    try {
      const next = await requestIncidentApproval(id, {
        action: '执行事件处置动作',
        risk: 'R2',
        details: { requestedFrom: 'incident-detail' },
      });
      setDetail(next);
    } catch {
      setError('审批申请失败');
    } finally {
      setApprovalBusy(false);
    }
  }

  async function decideApproval(id: string, approvalId: string, decision: 'approve' | 'deny') {
    setApprovalBusy(true);
    setError(null);
    try {
      const next = await decideIncidentApproval(id, approvalId, decision);
      setDetail(next);
    } catch {
      setError('审批处理失败');
    } finally {
      setApprovalBusy(false);
    }
  }

  async function openTemplate() {
    setTemplateOpen(true);
    setError(null);
    try {
      const template = await getIncidentReportTemplate();
      setTemplateBody(template.body);
    } catch {
      setError('报告模板加载失败');
    }
  }

  async function saveTemplate() {
    setTemplateBusy(true);
    setError(null);
    try {
      await saveIncidentReportTemplate(templateBody);
      setTemplateOpen(false);
    } catch {
      setError('报告模板保存失败');
    } finally {
      setTemplateBusy(false);
    }
  }

  async function recheck(id: string) {
    setRechecking(true);
    setError(null);
    try {
      setDetail(await recheckIncident(id));
    } catch {
      setError('复查取证失败');
    } finally {
      setRechecking(false);
    }
  }

  async function analyze(id: string) {
    setAnalyzing(true);
    setError(null);
    try {
      const result = await analyzeIncident(id);
      setAnalysisText(result.analysis);
      setDetail(result.detail);
    } catch {
      setError('Commander 分析失败');
    } finally {
      setAnalyzing(false);
    }
  }

  const selected = detail?.incident ?? incidents?.find((item) => item.id === selectedId) ?? null;
  const topologyEvidence = (detail?.evidence ?? []).find((item) => item.kind === 'topology');
  const topologyNodes = (() => {
    const raw = topologyEvidence?.payload?.nodes;
    if (!Array.isArray(raw)) return [] as Array<{ hostname: string; status: string; applications: string[] }>;
    return raw.flatMap((node) => {
      if (typeof node !== 'object' || node === null) return [];
      const record = node as Record<string, unknown>;
      const applications = Array.isArray(record.applications)
        ? record.applications.flatMap((app) => {
            if (typeof app === 'string') return [app];
            if (typeof app === 'object' && app !== null && typeof (app as Record<string, unknown>).name === 'string') {
              return [(app as Record<string, unknown>).name as string];
            }
            return [];
          })
        : [];
      return [{
        hostname: typeof record.hostname === 'string' ? record.hostname : 'unknown',
        status: typeof record.status === 'string' ? record.status : 'unknown',
        applications,
      }];
    });
  })();

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
        <div className="stack">
          <div className="tabs">
            {incidents.map((incident) => (
              <button
                key={incident.id}
                type="button"
                className={`tab${incident.id === selectedId ? ' is-active' : ''}`}
                onClick={() => setSelectedId(incident.id)}
              >
                {incident.title}<span className="count">{incident.severity}</span>
              </button>
            ))}
          </div>
          <section className="card">
            <div className="card-head">
              <h2>{selected?.title ?? '事件详情'}</h2>
              {selected ? <span className={`badge ${selected.status === 'resolved' || selected.status === 'closed' ? 'badge-ok' : 'badge-warn'}`}>{selected.status}</span> : null}
            </div>
            <div className="card-body">
              {selected ? (
                <>
                  <div className="row-between" style={{ marginBottom: 12 }}>
                    <div className="row-sm">
                      <span className="badge badge-neutral">{selected.severity}</span>
                      <span className="muted">事件 ID {selected.id.slice(0, 18)}</span>
                      <label className="muted">指挥官
                        <select
                          value={selected.commanderId ?? ''}
                          onChange={(event) => void assignCommander(selected.id, event.target.value)}
                          style={{ marginLeft: 6 }}
                        >
                          <option value="">未指派</option>
                          {members.map((member) => (
                            <option key={member.userId} value={member.userId}>{member.displayName || member.username}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="row-sm">
                      <button type="button" className="btn btn-outline btn-sm" disabled={investigating} onClick={() => void investigate(selected.id)}>
                        {investigating ? '排障执行中…' : '自动排障'}
                      </button>
                      <button type="button" className="btn btn-outline btn-sm" disabled={rechecking} onClick={() => void recheck(selected.id)}>
                        {rechecking ? '复查中…' : '复查取证'}
                      </button>
                      <button type="button" className="btn btn-outline btn-sm" disabled={analyzing} onClick={() => void analyze(selected.id)}>
                        {analyzing ? '分析中…' : 'Commander 分析'}
                      </button>
                      <a className="btn btn-outline btn-sm" href={`/api/incidents/${selected.id}/report`} target="_blank" rel="noreferrer">导出报告</a>
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => void openTemplate()}>报告模板</button>
                      <button type="button" className="btn btn-outline btn-sm" disabled={approvalBusy} onClick={() => void requestApproval(selected.id)}>申请 R2 审批</button>
                      {statusActions(selected)}
                    </div>
                  </div>
                  {templateOpen ? (
                    <div className="incident-evidence" style={{ marginBottom: 14 }}>
                      <div className="row-between">
                        <strong>事件报告模板</strong>
                        <div className="row-sm">
                          <button type="button" className="btn btn-primary btn-sm" disabled={templateBusy} onClick={() => void saveTemplate()}>
                            {templateBusy ? '保存中…' : '保存'}
                          </button>
                          <button type="button" className="btn btn-outline btn-sm" disabled={templateBusy} onClick={() => setTemplateOpen(false)}>取消</button>
                        </div>
                      </div>
                      <p className="muted" style={{ margin: '6px 0' }}>占位符：{'{{title}} {{id}} {{severity}} {{status}} {{source}} {{rootCause}} {{evidence}} {{hypotheses}} {{tickets}} {{timeline}}'}</p>
                      <textarea
                        value={templateBody}
                        onChange={(event) => setTemplateBody(event.target.value)}
                        rows={10}
                        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                      />
                    </div>
                  ) : null}
                  <div className="grid grid-2" style={{ alignItems: 'start' }}>
                    <div>
                      <h3>时间线</h3>
                      {detail?.events.length === 0 ? <p className="muted">暂无时间线事件</p> : null}
                      <div className="timeline">
                        {detail?.events.map((event) => (
                          <div key={event.id} className="timeline-item is-done">
                            <div className="t-title">{eventLabel(event.type)}</div>
                            <div className="t-meta">{formatTime(event.createdAt)} · {eventDetail(event.payload)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="stack">
                      <div className="card">
                        <div className="card-body">
                          <strong>处理团队</strong>
                          <div className="aside-row"><span>值班 SRE</span><span className="mono">on-call</span></div>
                          <div className="aside-row"><span>DBA</span><span className="mono">dba</span></div>
                          <div className="aside-row"><span>平台 SRE</span><span className="mono">platform</span></div>
                        </div>
                      </div>
                      <div className="card">
                        <div className="card-body">
                          <strong>待审批</strong>
                          <p className="muted">SSH 只读查询 · db-01</p>
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'approvals' }))}>打开审批中心</button>
                        </div>
                      </div>
                    </div>
                  </div>
                  {selected.rootCause ? (
                    <div className="root-cause-box">
                      <span className="eyebrow">ROOT CAUSE</span>
                      <p>{selected.rootCause}</p>
                    </div>
                  ) : null}
                  {analysisText ? (
                    <div className="root-cause-box">
                      <span className="eyebrow">COMMANDER ANALYSIS</span>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{analysisText}</p>
                    </div>
                  ) : null}
                  {topologyNodes.length > 0 ? (
                    <div className="incident-evidence" style={{ marginTop: 14 }}>
                      <span className="eyebrow">应用拓扑</span>
                      <div className="stack" style={{ marginTop: 8 }}>
                        {topologyNodes.map((node) => (
                          <div key={node.hostname} className="row-between">
                            <div>
                              <strong>{node.hostname}</strong>
                              <div className="muted">{node.applications.length > 0 ? node.applications.join('、') : '无应用信息'}</div>
                            </div>
                            <span className={`badge ${node.status === 'online' ? 'badge-ok' : 'badge-danger'}`}>{node.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <h3 style={{ marginTop: 18 }}>操作审批</h3>
                  {(detail?.approvals ?? []).length === 0 ? <p className="muted">暂无审批记录</p> : (
                    <div className="stack">
                      {(detail?.approvals ?? []).map((approval) => (
                        <div key={approval.id} className="incident-evidence">
                          <div className="row-between">
                            <strong>{approval.action}</strong>
                            <span className={`badge ${approval.status === 'approved' ? 'badge-ok' : approval.status === 'denied' ? 'badge-danger' : 'badge-warn'}`}>{approval.risk} · {approval.status}</span>
                          </div>
                          <span className="muted">{formatTime(approval.createdAt)}</span>
                          {approval.status === 'pending' ? (
                            <div className="row-sm" style={{ marginTop: 8 }}>
                              <button type="button" className="btn btn-primary btn-sm" disabled={approvalBusy} onClick={() => void decideApproval(selected.id, approval.id, 'approve')}>批准</button>
                              <button type="button" className="btn btn-outline btn-sm" disabled={approvalBusy} onClick={() => void decideApproval(selected.id, approval.id, 'deny')}>拒绝</button>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-2" style={{ alignItems: 'start', marginTop: 18 }}>
                    <div>
                      <h3>证据</h3>
                      {(detail?.evidence ?? []).length === 0 ? <p className="muted">暂无证据</p> : (
                        <div className="stack">
                          {(detail?.evidence ?? []).map((item) => (
                            <div key={item.id} className="incident-evidence">
                              <div className="row-between"><strong>{item.kind}</strong><span className="badge badge-neutral">{item.source}</span></div>
                              <p>{item.summary}</p>
                              <span className="muted">{formatTime(item.createdAt)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <h3>故障假设</h3>
                      {(detail?.hypotheses ?? []).length === 0 ? <p className="muted">暂无假设</p> : (
                        <div className="stack">
                          {(detail?.hypotheses ?? []).map((item) => (
                            <div key={item.id} className="incident-evidence">
                              <div className="row-between"><strong>{item.confidence}% 置信度</strong><span className={`badge ${item.status === 'supported' ? 'badge-ok' : item.status === 'rejected' ? 'badge-neutral' : 'badge-warn'}`}>{item.status}</span></div>
                              <p>{item.statement}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <h3 style={{ marginTop: 18 }}>处置任务</h3>
                  <table className="table">
                    <thead><tr><th>任务</th><th>负责人</th><th>状态</th></tr></thead>
                    <tbody>
                      {(detail?.tickets ?? []).length === 0 ? (
                        <tr><td colSpan={3} className="muted">暂无自动生成任务</td></tr>
                      ) : (detail?.tickets ?? []).map((ticket) => (
                        <tr key={ticket.id}>
                          <td>{ticket.title}</td>
                          <td>{ticket.assignee}</td>
                          <td><span className={`badge ${ticket.status === 'done' ? 'badge-ok' : 'badge-neutral'}`}>{ticket.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : <p className="muted">选择一条事件</p>}
            </div>
          </section>
        </div>
      ) : null}
    </DesignShell>
  );
}
