import { useEffect, useState } from 'react';
import {
  createFaultAnalysis,
  getFaultAnalysis,
  listAppSystems,
  listFaultAnalyses,
  type AppSystemSummary,
  type FaultAnalysisDetail,
  type FaultAnalysisSummary,
  type FaultTopology,
  type FaultTopologyEdge,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { relativeTime } from '../format.js';
import './faults.css';

export interface FaultsProps {
  readonly onBack: () => void;
}

type FaultView = 'list' | 'detail' | 'process' | 'collaboration';

function severityOf(analysis: FaultAnalysisSummary): 'critical' | 'warning' | 'info' {
  if (analysis.status !== 'completed') return 'critical';
  if (analysis.confidence < 0.5) return 'warning';
  return 'info';
}

function statusLabel(status: string): string {
  return status === 'completed' ? '已结论' : status === 'running' ? '分析中' : status;
}

function badgeClass(status: string): string {
  return status === 'completed' ? 'ok' : 'warn';
}

function hostAnomalies(topology: FaultTopology | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of topology?.nodes ?? []) map.set(node.hostname, node.anomalies);
  return map;
}

function endpointKey(host: string, app: string, port: number): string {
  return `${host}|${app}|${port}`;
}

function AccessTopology({ topology, title }: { topology: FaultTopology | undefined; title?: string }) {
  const nodes = topology?.nodes ?? [];
  const edges = topology?.edges ?? [];
  const alerts = hostAnomalies(topology);
  const endpoints = new Map<string, { host: string; app: string; port: number; source: boolean }>();
  for (const edge of edges) {
    endpoints.set(endpointKey(edge.fromHost, edge.fromApp, edge.fromPort), {
      host: edge.fromHost, app: edge.fromApp, port: edge.fromPort, source: true,
    });
    if (!endpoints.has(endpointKey(edge.toHost, edge.toApp, edge.toPort))) {
      endpoints.set(endpointKey(edge.toHost, edge.toApp, edge.toPort), {
        host: edge.toHost, app: edge.toApp, port: edge.toPort, source: false,
      });
    }
  }
  if (endpoints.size === 0) {
    for (const node of nodes) {
      const portText = node.ports[0] ?? '';
      const port = Number(portText.slice(portText.lastIndexOf(':') + 1)) || 0;
      endpoints.set(endpointKey(node.hostname, node.processes[0] ?? '', port), {
        host: node.hostname,
        app: node.processes[0] ?? '',
        port,
        source: true,
      });
    }
  }
  const list = [...endpoints.entries()].map(([key, value], index) => ({
    key,
    ...value,
    x: value.source ? 24 : 508,
    y: 46 + index * 92,
  }));
  const byKey = new Map(list.map((node) => [node.key, node]));
  const height = Math.max(320, list.length * 54 + 82);
  const hasEdges = edges.length > 0;

  return (
    <div className="fault-topology-panel">
      <div className="fault-topology-head">
        <div>
          <div className="section-label">Access topology</div>
          <h2>{title ?? '自动绘制的访问关系'}</h2>
        </div>
        <div className="fault-legend">
          <span><i style={{ background: 'var(--fault-red)' }} />根因节点</span>
          <span><i style={{ background: '#ddb36b' }} />受影响节点</span>
          <span><i style={{ background: 'var(--line-strong)' }} />普通节点</span>
        </div>
      </div>
      {nodes.length === 0 && edges.length === 0 ? (
        <div className="fault-empty">下一次分析采集系统访问连接后，会在这里生成访问关系。</div>
      ) : (
        <svg className="fault-topo-svg" viewBox={`0 0 760 ${height}`} role="img" aria-label="应用访问关系">
          <defs>
            <marker id="fault-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--fault-red)" />
            </marker>
          </defs>
          {edges.map((edge: FaultTopologyEdge, index) => {
            const from = byKey.get(endpointKey(edge.fromHost, edge.fromApp, edge.fromPort));
            const to = byKey.get(endpointKey(edge.toHost, edge.toApp, edge.toPort));
            if (!from || !to) return null;
            const mid = (from.x + to.x) / 2;
            return (
              <g key={`${edge.fromHost}-${edge.fromPort}-${edge.toHost}-${edge.toPort}-${index}`}>
                <path className="ft-edge root" d={`M ${from.x + 204} ${from.y + 28} C ${mid} ${from.y + 28}, ${mid} ${to.y + 28}, ${to.x - 4} ${to.y + 28}`} markerEnd="url(#fault-arrow)" />
                <text className="ft-label root" x={mid} y={(from.y + to.y) / 2 + 20} textAnchor="middle">
                  {(edge.fromApp || 'unknown')} → {(edge.toApp || 'unknown')}:{edge.toPort} · {edge.count}
                </text>
              </g>
            );
          })}
          {list.map((node) => {
            const hostAlerts = alerts.get(node.host) ?? [];
            const info = nodes.find((item) => item.hostname === node.host);
            const hasAlert = hostAlerts.length > 0;
            return (
              <g key={node.key}>
                <rect className={`ft-node ${hasAlert ? 'root' : ''}`} x={node.x} y={node.y} width="228" height="76" rx="5" />
                <text className="ft-title" x={node.x + 11} y={node.y + 17}>{node.host}</text>
                <text className="ft-sub" x={node.x + 11} y={node.y + 31}>{node.app || info?.ip || '未映射进程'}</text>
                <text className="ft-line" x={node.x + 11} y={node.y + 45}>{node.app ? `${node.app} :${node.port}` : `监听 :${node.port || '-'}`}</text>
                <text className={`ft-alert ${hasAlert ? '' : 'warn'}`} x={node.x + 11} y={node.y + 60}>
                  {hasAlert ? `告警：${hostAlerts[0]?.slice(0, 36)}` : (info?.status === 'online' ? '状态正常' : '节点异常')}
                </text>
                {hasAlert ? <circle cx={node.x + 216} cy={node.y + 12} r="3" fill="var(--fault-red)" /> : null}
              </g>
            );
          })}
          {!hasEdges && nodes.length > 0 ? (
            <text className="ft-label" x="24" y={height - 22}>暂无跨节点连接，显示主机与巡检异常。</text>
          ) : null}
        </svg>
      )}
      <div className="fault-topo-foot">
        <span><strong>来源：</strong>{topology?.nodes.length ?? 0} 个节点、{topology?.edges.length ?? 0} 条 ESTAB 边</span>
        <span><strong>映射：</strong>IP → 节点，端口 → 进程/服务</span>
        <span><strong>异常：</strong>{[...alerts.values()].filter((items) => items.length > 0).length} 个节点</span>
      </div>
    </div>
  );
}

function FaultList({
  analyses, systems, busy, latest, filter, onFilter, onOpen, onStart,
}: {
  analyses: FaultAnalysisSummary[];
  systems: AppSystemSummary[];
  busy: boolean;
  latest: FaultAnalysisDetail | null;
  filter: 'all' | 'running' | 'completed';
  onFilter: (filter: 'all' | 'running' | 'completed') => void;
  onOpen: (id: string) => void;
  onStart: (id: string) => void;
}) {
  const running = analyses.filter((item) => item.status !== 'completed').length;
  const tasks = latest?.steps.filter((step) => step.type === 'dispatch') ?? [];
  return (
    <>
      <div className="fault-kpis">
        <div className="fault-kpi"><div className="fault-kpi-label"><span>进行中的定界</span><span className="mono">LIVE</span></div><div className="fault-kpi-value">{running}</div><div className="fault-kpi-note"><strong>{running}</strong> 个案例正在收敛</div></div>
        <div className="fault-kpi"><div className="fault-kpi-label"><span>纳管应用系统</span><span className="mono">SYSTEMS</span></div><div className="fault-kpi-value">{systems.length}</div><div className="fault-kpi-note">按应用系统汇总异常</div></div>
        <div className="fault-kpi"><div className="fault-kpi-label"><span>已结论</span><span className="mono">DONE</span></div><div className="fault-kpi-value">{analyses.filter((item) => item.status === 'completed').length}</div><div className="fault-kpi-note"><strong>{analyses.filter((item) => item.confidence >= 0.65).length}</strong> 条高置信度</div></div>
        <div className="fault-kpi"><div className="fault-kpi-label"><span>定界历史</span><span className="mono">7 DAYS</span></div><div className="fault-kpi-value">{analyses.length}</div><div className="fault-kpi-note ok">最近信号持续汇入</div></div>
      </div>
      <div className="fault-toolbar">
        <button className={`fault-chip${filter === 'all' ? ' is-active' : ''}`} type="button" onClick={() => onFilter('all')}>全部 {analyses.length}</button>
        <button className={`fault-chip${filter === 'running' ? ' is-active' : ''}`} type="button" onClick={() => onFilter('running')}>分析中 {running}</button>
        <button className={`fault-chip${filter === 'completed' ? ' is-active' : ''}`} type="button" onClick={() => onFilter('completed')}>已结论 {analyses.filter((item) => item.status === 'completed').length}</button>
        <span className="fault-toolbar-note">按最近信号排序 · 自动刷新 30s</span>
      </div>
      <div className="fault-layout">
        <section className="fault-panel">
          <div className="fault-panel-head"><h2>定界案例</h2><span className="muted">最近 {analyses.length} 个</span></div>
          <div className="fault-rows">
            {analyses.length === 0 ? <div className="fault-empty">暂无定界案例。操作系统智能体上报 open 异常后会自动生成。</div> : null}
            {analyses.slice(0, 30).map((analysis) => {
              const sev = severityOf(analysis);
              return (
                <button key={analysis.id} type="button" className="fault-case" onClick={() => onOpen(analysis.id)}>
                  <span className={`fault-case-sev ${sev}`} />
                  <span>
                    <span className="fault-case-title">{analysis.appSystemName}<span className={`fault-badge ${analysis.status === 'completed' ? 'ok' : 'warn'}`}>{statusLabel(analysis.status)}</span></span>
                    <span className="fault-case-meta">{analysis.rootCause || analysis.summary || '等待总调度收敛根因'}<span>·</span><span>{relativeTime(analysis.createdAt)}</span></span>
                  </span>
                  <span className="fault-case-scope"><strong>{analysis.rootCause ? '1' : '—'}</strong> 根因候选<br /><span className="muted">{analysis.appSystemName}</span></span>
                  <span className="fault-case-conf">置信度 <strong className="mono">{Math.round(analysis.confidence * 100)}%</strong><span className="fault-conf-bar"><i style={{ width: `${Math.round(analysis.confidence * 100)}%` }} /></span></span>
                  <span className="fault-case-time">{relativeTime(analysis.createdAt)}<span>查看定界 →</span></span>
                </button>
              );
            })}
          </div>
        </section>
        <aside className="fault-rail">
          <section className="fault-panel">
            <div className="fault-panel-head"><h2>发起定界</h2><span className="muted">应用系统</span></div>
            <div className="card-body">
              {systems.length === 0 ? <p className="fault-note">暂无应用系统。</p> : null}
              {systems.slice(0, 5).map((system) => (
                <div key={system.id} className="row-between" style={{ marginBottom: 9 }}>
                  <div><strong>{system.name}</strong><div className="fault-muted">{system.onlineCount}/{system.agentCount} 节点在线</div></div>
                  <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => onStart(system.id)}>开始分析</button>
                </div>
              ))}
            </div>
          </section>
          <section className="fault-panel">
            <div className="fault-panel-head"><h2>最近补采</h2><span className="muted">{tasks.length} 项</span></div>
            <div className="card-body">
              {tasks.length === 0 ? <p className="fault-note">暂无补采任务。分析需要更多证据时会自动下发。</p> : null}
              {tasks.slice(0, 4).map((step) => (
                <div key={step.id} className="fault-probe">
                  <span className="fault-probe-icon"><svg><use href="/icons.svg#i-terminal" /></svg></span>
                  <span><span className="fault-probe-title">{step.title}</span><span className="fault-probe-meta">{step.detail}</span></span>
                  <span className={`fault-badge ${step.status === 'completed' ? 'ok' : 'warn'}`}>{step.status === 'completed' ? 'DONE' : 'RUN'}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="fault-panel">
            <div className="fault-panel-head"><h2>定界方法</h2><span className="muted">v0.2</span></div>
            <div className="card-body">
              <ul className="fault-rule-list">
                <li><span className="fault-rule-index">01</span><span><b>按应用系统聚合。</b>同窗口同类异常进入同一个 Case。</span></li>
                <li><span className="fault-rule-index">02</span><span><b>拓扑算边界。</b>用 Agent 上报的连接关系计算上下游。</span></li>
                <li><span className="fault-rule-index">03</span><span><b>证据不足再补采。</b>只下发受控 probe。</span></li>
                <li><span className="fault-rule-index">04</span><span><b>结论必须带证据。</b>总调度只引用已存在证据。</span></li>
              </ul>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function DetailView({
  detail, onBack, onProcess,
}: {
  detail: FaultAnalysisDetail;
  onBack: () => void;
  onProcess: () => void;
}) {
  const topology = detail.evidence?.context?.topology;
  const steps = detail.steps;
  const findings = detail.findings;
  const agents = [...new Set(steps.filter((step) => step.type === 'dispatch').map((step) => step.title.replace(/^调度 /, '').replace(/ 补充数据$/, '')))];
  const probes = steps.filter((step) => step.type === 'dispatch').length;
  const anomalies = topology?.nodes.filter((node) => node.anomalies.length > 0).length ?? 0;
  const apps = new Set((topology?.edges ?? []).flatMap((edge) => [edge.fromApp, edge.toApp]).filter(Boolean));
  return (
    <>
      <button type="button" className="fault-back" onClick={onBack}>← 返回定界工作台</button>
      <section className="fault-detail-head">
        <div className="fault-detail-title-row">
          <div>
            <div className="section-label">Fault case · {detail.appSystemName}</div>
            <h2 className="fault-detail-title">{detail.rootCause || detail.title}</h2>
            <div className="fault-detail-sub">
              <span className={`fault-badge ${badgeClass(detail.status)}`}>{statusLabel(detail.status)}</span>
              <span>应用系统 <strong>{detail.appSystemName}</strong></span>
              <span>开始于 {relativeTime(detail.createdAt)}</span>
            </div>
          </div>
          <div className="fault-actions">
            <button type="button" className="btn btn-outline btn-sm" onClick={onProcess}>查看定界过程</button>
            <button type="button" className="btn btn-primary btn-sm">创建事件</button>
          </div>
        </div>
        <div className="fault-detail-stats">
          <div><div className="fault-stat-label">受影响节点</div><div className="fault-stat-value danger">{anomalies} / {topology?.nodes.length ?? 0}</div></div>
          <div><div className="fault-stat-label">受影响应用</div><div className="fault-stat-value warn">{apps.size}</div></div>
          <div><div className="fault-stat-label">自动补采</div><div className="fault-stat-value">{probes}</div></div>
          <div><div className="fault-stat-label">根因置信度</div><div className="fault-stat-value">{Math.round(detail.confidence * 100)}%</div></div>
        </div>
      </section>
      <div className="fault-collab-summary">
        <span className="section-label">Agent collaboration</span>
        {agents.length === 0 ? <span className="fault-muted">本次分析未调度操作系统智能体</span> : agents.slice(0, 4).map((agent) => (
          <span key={agent} className="fault-agent-chip"><i />{agent}<small>{steps.filter((step) => step.title.includes(agent)).length} steps</small></span>
        ))}
        <button type="button" className="fault-collab-link" onClick={onProcess}>查看智能体协作过程 →</button>
      </div>
      <div className="fault-detail-grid">
        <section className="fault-panel">
          <AccessTopology topology={topology} />
        </section>
        <aside className="fault-panel">
          <div className="fault-panel-head"><h2>根因候选</h2><span className="muted">Top {Math.max(findings.length, 1)}</span></div>
          {findings.length === 0 ? <div className="fault-empty">未形成结构化候选。</div> : findings.slice(0, 3).map((finding, index) => {
            const score = Math.max(0.2, detail.confidence - index * 0.17);
            return (
              <div key={`${finding.title}-${index}`} className="fault-candidate">
                <div className="fault-candidate-top"><div className="fault-candidate-name">{finding.title || '根因候选'}</div><div className="fault-candidate-score">{score.toFixed(2)}</div></div>
                <div className="fault-candidate-desc">{finding.detail || '等待更多证据。'}</div>
                <div className="fault-score"><i className={index === 0 ? 'danger' : ''} style={{ width: `${score * 100}%` }} /></div>
                <div className="fault-tags"><span className="fault-evidence-tag">EVT-{String(index + 1).padStart(3, '0')}</span><span className="fault-evidence-tag">STEP-{detail.steps[index]?.seq ?? index}</span></div>
              </div>
            );
          })}
        </aside>
      </div>
      <div className="fault-detail-grid">
        <section className="fault-panel">
          <div className="fault-panel-head"><h2>证据链</h2><span className="muted">{steps.length} 步</span></div>
          <div className="fault-timeline">
            {steps.length === 0 ? <div className="fault-empty">暂无分析步骤。</div> : steps.slice(0, 10).map((step) => (
              <div className="fault-tl" key={step.id}>
                <div className="fault-tl-time">{new Date(step.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
                <span className={`fault-tl-dot ${step.type === 'dispatch' ? 'probe' : step.type === 'result' ? 'ok' : 'alert'}`} />
                <div><div className="fault-tl-title">{step.title}</div><div className="fault-tl-desc">{step.detail}</div></div>
              </div>
            ))}
          </div>
        </section>
        <section className="fault-panel">
          <div className="fault-panel-head"><h2>补采任务</h2><span className="muted">受控 probe</span></div>
          <div className="card-body">
            {steps.filter((step) => step.type === 'dispatch').length === 0 ? <p className="fault-note">暂无补采任务。</p> : null}
            {steps.filter((step) => step.type === 'dispatch').slice(0, 6).map((step) => (
              <div key={step.id} className="fault-return"><span className="fault-return-dot" /><div><strong>{step.title}</strong><span>{step.detail}</span></div></div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function OrchestrationMap({ detail }: { detail: FaultAnalysisDetail }) {
  const dispatches = detail.steps.filter((step) => step.type === 'dispatch');
  const events = detail.evidence?.context?.events ?? [];
  const hosts = [...new Set(dispatches.map((step) => step.title.replace(/^调度 /, '').replace(/ 补充数据$/, '')))].slice(0, 3);
  const rowY = (index: number) => 48 + index * 84;
  return (
    <div className="fault-panel fault-orch-panel">
      <div className="fault-panel-head" style={{ padding: '0 0 8px', borderBottom: 0 }}>
        <div><div className="section-label">Orchestration topology</div><h2 style={{ margin: '3px 0 0', fontSize: 13 }}>从发现到结论的调度拓扑</h2><p className="fault-note" style={{ marginTop: 4 }}>总调度下发受控采集任务，操作系统智能体返回本机事实，平台再更新边界和根因。</p></div>
        <span className="muted">{dispatches.length} 次调度 / {hosts.length} 个 Agent</span>
      </div>
      <svg className="fault-orch-svg" viewBox="0 0 1000 500" role="img" aria-label="故障定界调度拓扑">
        <text className="fo-label" x="22" y="24">01 发现</text>
        <text className="fo-label" x="330" y="24">02 总调度</text>
        <text className="fo-label" x="738" y="24">03 操作系统智能体</text>
        <text className="fo-label" x="330" y="300">04 二次决策</text>
        <text className="fo-label" x="330" y="438">05 最终结论</text>
        {events.slice(0, 3).map((event, index) => (
          <g key={`${event.hostname}-${event.title}-${index}`}>
            <rect className="fo-node" x="22" y={44 + index * 62} width="250" height="48" rx="5" />
            <text className="fo-title" x="36" y={64 + index * 62}>{event.title.slice(0, 24)}</text>
            <text className="fo-sub" x="36" y={79 + index * 62}>{event.hostname} · {event.severity}</text>
            <path className="fo-flow" d={`M272 ${68 + index * 62} C300 ${68 + index * 62}, 300 98, 330 98`} />
          </g>
        ))}
        <rect className="fo-node master" x="330" y="44" width="220" height="86" rx="6" />
        <text className="fo-title" x="346" y="64">总调度智能体</text>
        <text className="fo-line" x="346" y="82">汇总 {events.length} 条异常 · 建 Case</text>
        <text className="fo-line" x="346" y="98">生成候选 · 下发受控采集</text>
        <text className="fo-label" x="346" y="118">round 1</text>
        {hosts.map((host, index) => (
          <g key={host}>
            <path className="fo-flow" d={`M550 88 C650 88, 690 ${rowY(index) + 26}, 738 ${rowY(index) + 26}`} />
            <rect className="fo-node agent" x="738" y={rowY(index)} width="240" height="62" rx="5" />
            <text className="fo-title" x="752" y={rowY(index) + 18}>{host}</text>
            <text className="fo-sub" x="752" y={rowY(index) + 34}>受控采集 · 本机连接信息 / 进程 / 端口</text>
            <text className="fo-label" x="752" y={rowY(index) + 49}>返回证据</text>
            <path className="fo-flow return" d={`M738 ${rowY(index) + 40} C650 ${rowY(index) + 40}, 620 150, 550 150`} />
          </g>
        ))}
        <path className="fo-flow" d={`M${hosts.length > 0 ? 878 : 440} ${rowY(Math.max(hosts.length - 1, 0)) + 62} C878 230, 700 220, 660 250`} />
        <rect className="fo-node decision" x="330" y="246" width="290" height="78" rx="6" />
        <text className="fo-title" x="346" y="266">总调度二次决策</text>
        <text className="fo-line" x="346" y="284">合并 Agent 返回证据，更新边界</text>
        <text className="fo-line" x="346" y="300">按拓扑上游 + 异常时间顺序收敛候选</text>
        <text className="fo-label red" x="346" y="315">候选置信度 {Math.round(detail.confidence * 100)}%</text>
        <path className="fo-flow result" d="M475 324 C475 360, 475 370, 475 392" />
        <rect className="fo-node result" x="300" y="392" width="470" height="72" rx="6" />
        <text className="fo-title" x="316" y="414">最终结论 · {detail.rootCause ? detail.rootCause.slice(0, 30) : '等待总调度结论'}</text>
        <text className="fo-line" x="316" y="432">{detail.appSystemName} · 置信度 {Math.round(detail.confidence * 100)}% · {detail.status === 'completed' ? '待人工确认' : '分析中'}</text>
        <text className="fo-line" x="316" y="448">证据 {detail.steps.length} 步 · 自动补采 {dispatches.length} 次</text>
      </svg>
    </div>
  );
}

function ProcessView({ detail, onBack, onCollaboration }: { detail: FaultAnalysisDetail; onBack: () => void; onCollaboration: () => void }) {
  const topology = detail.evidence?.context?.topology;
  const dispatches = detail.steps.filter((step) => step.type === 'dispatch');
  const evidence = detail.steps.filter((step) => step.type === 'evidence');
  return (
    <>
      <button type="button" className="fault-back" onClick={onBack}>← 返回定界详情</button>
      <OrchestrationMap detail={detail} />
      <div className="fault-panel">
        <div className="fault-panel-head"><h2>总调度 → 操作系统智能体 → 总调度</h2><span className="muted">{dispatches.length} 次调度 / {evidence.length} 次返回</span></div>
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          {dispatches.length === 0 ? <p className="fault-note">本次分析没有触发自动补采。</p> : dispatches.map((step) => {
            const host = step.title.replace(/^调度 /, '').replace(/ 补充数据$/, '');
            const answer = evidence.find((item) => item.title.startsWith(host));
            return (
              <div key={step.id} className="fault-agent-run">
                <div className="fault-agent-run-head"><strong>平台总调度 → {host}</strong><span className="fault-badge ok">PROBE</span></div>
                <p>{step.detail}</p>
                {answer ? <p><strong>Agent 返回：</strong>{answer.detail}</p> : <p className="fault-muted">等待 Agent 返回…</p>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="fault-panel">
        <div className="fault-panel-head"><h2>自动生成访问关系</h2><span className="muted">来自 Agent 访问连接</span></div>
        <AccessTopology topology={topology} title="节点、进程、服务与端口访问关系" />
      </div>
      <div className="fault-process-grid">
        <section className="fault-panel fault-process-card"><div className="section-label">Returned facts</div><h3>智能体采集到的本机事实</h3>{evidence.length === 0 ? <p>暂无补充证据。</p> : evidence.slice(0, 3).map((item) => <div key={item.id} className="fault-return"><span className="fault-return-dot" /><div><strong>{item.title}</strong><span>{item.detail}</span></div></div>)}</section>
        <section className="fault-panel fault-process-card"><div className="section-label">Decision changes</div><h3>每次返回如何改变决策</h3>{detail.findings.slice(0, 3).map((finding, index) => <div key={`${finding.title}-${index}`} className="fault-score-change"><div><strong>{finding.title || '候选'}</strong><span>{finding.detail || '—'}</span></div><b>{index === 0 ? '已收敛' : '候选'}</b></div>)}</section>
        <section className="fault-panel fault-process-card"><div className="section-label">Conclusion</div><h3>结论收敛条件</h3><p>{detail.summary || '等待总调度完成收敛。'}</p><button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 8 }} onClick={onCollaboration}>查看完整智能体对话</button></section>
      </div>
      <section className="fault-conclusion">
        <div className="fault-conclusion-head"><div className="fault-actions"><span className="section-label">Final conclusion</span><span className={`fault-badge ${badgeClass(detail.status)}`}>{statusLabel(detail.status)}</span></div><button type="button" className="btn btn-primary btn-sm">确认根因</button></div>
        <div className="fault-conclusion-body">
          <div><div className="fault-conclusion-text">{detail.rootCause || '分析仍在进行中。'}<span className="muted">{detail.summary}</span></div><div className="fault-tags">{detail.steps.slice(0, 5).map((step) => <span key={step.id} className="fault-evidence-tag">STEP-{step.seq}</span>)}</div></div>
          <div className="fault-conclusion-side"><div className="fault-confidence"><strong>{Math.round(detail.confidence * 100)}%</strong><span>根因置信度</span></div><div className="fault-check"><b>✓</b>已汇总应用系统异常</div><div className="fault-check"><b>✓</b>已自动调度智能体</div><div className="fault-check"><b>✓</b>已合并返回证据</div><div className="fault-recommend">检查相关进程、端口和日志<span>基于本次定界证据</span></div></div>
        </div>
      </section>
    </>
  );
}

function CollaborationView({ detail, onBack }: { detail: FaultAnalysisDetail; onBack: () => void }) {
  const steps = detail.steps;
  const runs = detail.evidence?.evidence ?? [];
  return (
    <>
      <button type="button" className="fault-back" onClick={onBack}>← 返回定界过程</button>
      <section className="fault-detail-head">
        <div className="section-label">Agent collaboration</div>
        <h2 className="fault-detail-title">操作系统智能体协作过程</h2>
        <div className="fault-detail-sub"><span className="fault-badge warn">{detail.status === 'completed' ? '已完成' : '进行中'}</span><span>{runs.length} 个 Agent 返回</span><span>{steps.filter((step) => step.type === 'dispatch').length} 次调度</span></div>
      </section>
      <div className="fault-detail-grid">
        <section className="fault-panel">
          <div className="fault-panel-head"><h2>协作时间线</h2><span className="muted">平台 ↔ 操作系统智能体</span></div>
          <div className="card-body">
            {steps.length === 0 ? <div className="fault-empty">暂无协作记录。</div> : steps.map((step) => (
              <div key={step.id} className="fault-agent-run">
                <div className="fault-agent-run-head"><strong>{step.title}</strong><span className={`fault-badge ${step.type === 'dispatch' ? 'warn' : step.type === 'result' ? 'ok' : 'neutral'}`}>{step.type}</span></div>
                <p>{step.detail}</p>
              </div>
            ))}
          </div>
        </section>
        <aside className="fault-rail">
          <section className="fault-panel"><div className="fault-panel-head"><h2>Agent 返回</h2><span className="muted">{runs.length} 条</span></div><div className="card-body">{runs.length === 0 ? <p className="fault-note">暂无 Agent 返回结果。</p> : runs.map((run, index) => <div key={`${run.hostname}-${index}`} className="fault-agent-run"><div className="fault-agent-run-head"><strong>{run.hostname}</strong><span className={`fault-badge ${run.status === 'completed' ? 'ok' : 'warn'}`}>{run.status}</span></div><p>{run.analysis || run.answer || '无分析文本'}</p></div>)}</div></section>
        </aside>
      </div>
    </>
  );
}

export function Faults({ onBack }: FaultsProps) {
  const [analyses, setAnalyses] = useState<FaultAnalysisSummary[] | null>(null);
  const [systems, setSystems] = useState<AppSystemSummary[]>([]);
  const [latest, setLatest] = useState<FaultAnalysisDetail | null>(null);
  const [view, setView] = useState<FaultView>('list');
  const [selected, setSelected] = useState<FaultAnalysisDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'running' | 'completed'>('all');

  async function reload() {
    const list = await listFaultAnalyses();
    setAnalyses(list);
    setSystems(await listAppSystems());
    if (list[0]) {
      const detail = await getFaultAnalysis(list[0].id);
      setLatest(detail);
    } else {
      setLatest(null);
    }
  }

  useEffect(() => {
    void reload().catch(() => setError('故障定界数据加载失败'));
    const timer = window.setInterval(() => { void reload().catch(() => undefined); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setSelected(null);
    void getFaultAnalysis(selectedId).then((detail) => {
      setSelected(detail);
      setLatest(detail);
    }).catch(() => setError('分析详情加载失败'));
  }, [selectedId]);

  async function open(id: string) {
    setSelectedId(id);
    setView('detail');
  }

  async function start(appSystemId: string) {
    setBusy(true);
    setError(null);
    try {
      const created = await createFaultAnalysis(appSystemId);
      await reload();
      await open(created.id);
    } catch {
      setError('发起故障定界失败');
    } finally {
      setBusy(false);
    }
  }

  const current = selected;
  const title = view === 'list' ? '故障定界' : view === 'detail' ? '故障定界详情' : view === 'process' ? '故障定界过程' : '智能体协作';
  const subtitle = view === 'list'
    ? '按应用系统汇总异常与指标，沿访问关系计算边界，自动调度操作系统智能体补采证据，最终收敛根因。'
    : undefined;

  return (
    <DesignShell
      active="faults"
      eyebrow={view === 'list' ? 'Fault boundary' : 'Fault case'}
      title={title}
      {...(subtitle ? { subtitle } : {})}
      onBack={onBack}
      actions={view === 'list' ? (
        <div className="fault-actions">
          <button type="button" className="btn btn-outline" onClick={() => { void reload().catch(() => setError('刷新失败')); }}>刷新信号</button>
          <button type="button" className="btn btn-primary" disabled={busy || systems.length === 0} onClick={() => systems[0] ? void start(systems[0].id) : undefined}>发起定界</button>
        </div>
      ) : view === 'detail' ? (
        <div className="fault-actions"><button type="button" className="btn btn-outline" onClick={() => setView('process')}>查看过程</button></div>
      ) : null}
    >
      <div className="faults-ui">
        {error ? <p className="form-error">{error}</p> : null}
        {view === 'list' ? (
          <FaultList analyses={(analyses ?? []).filter((item) => filter === 'all' || (filter === 'running' ? item.status !== 'completed' : item.status === 'completed'))} systems={systems} busy={busy} latest={latest} filter={filter} onFilter={setFilter} onOpen={(id) => void open(id)} onStart={(id) => void start(id)} />
        ) : null}
        {view === 'detail' && current ? <DetailView detail={current} onBack={() => setView('list')} onProcess={() => setView('process')} /> : null}
        {view === 'process' && current ? <ProcessView detail={current} onBack={() => setView('detail')} onCollaboration={() => setView('collaboration')} /> : null}
        {view === 'collaboration' && current ? <CollaborationView detail={current} onBack={() => setView('process')} /> : null}
        {view !== 'list' && !current ? <div className="fault-empty">分析数据加载中…</div> : null}
      </div>
    </DesignShell>
  );
}
