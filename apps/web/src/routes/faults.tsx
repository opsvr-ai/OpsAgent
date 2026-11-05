import { useEffect, useState } from 'react';
import {
  createFaultAnalysis,
  getFaultAnalysis,
  listAppSystems,
  listFaultAnalyses,
  type AppSystemSummary,
  type FaultAnalysisDetail,
  type FaultAnalysisSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { relativeTime } from '../format.js';

export interface FaultsProps {
  readonly onBack: () => void;
}

export function Faults({ onBack }: FaultsProps) {
  const [analyses, setAnalyses] = useState<FaultAnalysisSummary[] | null>(null);
  const [systems, setSystems] = useState<AppSystemSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FaultAnalysisDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setAnalyses(await listFaultAnalyses());
    setSystems(await listAppSystems());
  }
  useEffect(() => {
    void reload().catch(() => setError('故障定界数据加载失败'));
  }, []);
  useEffect(() => {
    if (!selectedId) return;
    setDetail(null);
    void getFaultAnalysis(selectedId).then(setDetail).catch(() => setError('分析详情加载失败'));
  }, [selectedId]);

  async function start(appSystemId: string) {
    setBusy(true);
    setError(null);
    try {
      const created = await createFaultAnalysis(appSystemId);
      await reload();
      setSelectedId(created.id);
    } catch {
      setError('发起故障定界失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DesignShell
      active="faults"
      eyebrow="Fault boundary"
      title="故障定界分析"
      subtitle="按应用系统汇总异常与指标，自动调度操作系统智能体补采证据，由总调度智能体输出最终根因。"
      onBack={onBack}
    >
      {error ? <p className="form-error">{error}</p> : null}
      <section className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>发起定界</h2><span className="muted">应用系统</span></div>
          <div className="card-body stack">
            <p className="muted">选择应用系统，汇总该系统全部节点的告警、指标和重要巡检对象，必要时自动补采进程、日志和端口。</p>
            {systems.map((system) => (
              <div key={system.id} className="row-between">
                <div><strong>{system.name}</strong><div className="muted">{system.onlineCount}/{system.agentCount} 节点在线</div></div>
                <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void start(system.id)}>开始分析</button>
              </div>
            ))}
            {systems.length === 0 ? <p className="muted">暂无应用系统。</p> : null}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>分析结果</h2><span className="badge badge-neutral">{analyses?.length ?? 0}</span></div>
          <div className="card-body stack">
            {analyses?.length === 0 ? <p className="muted">暂无分析。异常上报后会自动生成。</p> : null}
            {analyses?.slice(0, 30).map((analysis) => (
              <button key={analysis.id} type="button" className={`app-system-card${selectedId === analysis.id ? ' is-active' : ''}`} onClick={() => setSelectedId(analysis.id)}>
                <span className="row-between"><strong>{analysis.appSystemName}</strong><span className={`badge ${analysis.status === 'completed' ? 'badge-ok' : 'badge-warn'}`}>{analysis.status}</span></span>
                <span className="muted">{analysis.rootCause || analysis.summary || '分析中…'}</span>
                <span className="muted">{relativeTime(analysis.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {detail ? (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head"><h2>{detail.title}</h2><span className={`badge ${detail.status === 'completed' ? 'badge-ok' : 'badge-warn'}`}>{detail.status}</span></div>
          <div className="card-body stack">
            <div className="detail-split">
              <div><div className="eyebrow">应用系统</div><strong>{detail.appSystemName}</strong><p className="muted">{relativeTime(detail.createdAt)}</p></div>
              <div><div className="eyebrow">置信度</div><strong>{Math.round(detail.confidence * 100)}%</strong></div>
            </div>
            <div className="root-cause-box"><span className="eyebrow">ROOT CAUSE</span><p>{detail.rootCause || '分析中…'}</p></div>
            {detail.findings.length > 0 ? (
              <div className="stack">
                {detail.findings.map((finding, index) => (
                  <div key={`${finding.title}-${index}`} className="incident-evidence">
                    <div className="row-between"><strong>{finding.title ?? '发现'}</strong><span className="badge badge-warn">{finding.severity ?? 'info'}</span></div>
                    <p>{finding.detail ?? ''}</p>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="stack">
              <span className="eyebrow">分析过程</span>
              {detail.steps.map((step) => (
                <div key={step.id} className="row-between">
                  <div><strong>{step.title}</strong><div className="muted">{step.detail}</div></div>
                  <span className={`badge ${step.status === 'completed' ? 'badge-ok' : 'badge-warn'}`}>{step.type}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </DesignShell>
  );
}
