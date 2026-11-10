import type { ReactElement } from 'react';
import type { TopologyGraph, TopologyHotPath, TopologyInsight } from '@opsagent/contracts';
import { relativeTime } from '../format.js';
import {
  displayProduct,
  formatConnections,
  kindLabel,
  productTone,
  serviceLabel,
  truncateText,
  type PositionedNode,
  type ViewGraph,
} from './layout.js';
import { KindIcon, MiniIcon } from './icons.js';

export interface AnalysisPanelProps {
  readonly graph: TopologyGraph;
  readonly activeHotPath: number | null;
  readonly activeInsightId: string | null;
  readonly onHotPath: (index: number) => void;
  readonly onInsight: (insight: TopologyInsight) => void;
  readonly onClear: () => void;
}

const SEVERITY_LABEL: Record<TopologyInsight['severity'], string> = {
  critical: '严重',
  warning: '关注',
  info: '提示',
};

function nodeLabel(graph: TopologyGraph, id: string): string {
  return graph.nodes.find((node) => node.id === id)?.label ?? id;
}

function windowLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

function PathChain({ graph, path }: { graph: TopologyGraph; path: TopologyHotPath }): ReactElement {
  const full = path.nodeIds.map((id) => nodeLabel(graph, id)).join(' → ');
  return (
    <span className="topo-hotpath-chain" title={full}>
      {path.nodeIds.map((id, index) => (
        <span key={id}>
          {index > 0 ? <em> → </em> : null}
          {nodeLabel(graph, id)}
        </span>
      ))}
    </span>
  );
}

export function AnalysisPanel({
  graph,
  activeHotPath,
  activeInsightId,
  onHotPath,
  onInsight,
  onClear,
}: AnalysisPanelProps): ReactElement {
  const analysis = graph.analysis;
  const fallback = analysis.fallback ?? false;
  const confidence = Math.round(analysis.confidence * 100);
  const insights = analysis.insights;
  const risks = analysis.risks ?? [];
  const rawModel = (analysis.model ?? '').trim();
  const modelLabel = fallback || rawModel === '' || rawModel === 'llm' || rawModel === 'fallback'
    ? '规则引擎兜底'
    : rawModel;
  const shortModel = modelLabel.length > 16 ? `${modelLabel.slice(0, 16)}…` : modelLabel;
  return (
    <div className="topo-rail-scroll">
      <div className="topo-rail-head">
        <div>
          <div className="topo-rail-eyebrow">AI ANALYSIS · 模型识别</div>
          <h2 className="topo-rail-title">拓扑分析</h2>
        </div>
        <span className={`topo-model-badge${fallback ? ' is-fallback' : ''}`} title={modelLabel}>
          <MiniIcon name="spark" size={12} />
          {shortModel}
        </span>
      </div>

      <p className="topo-summary">{analysis.summary}</p>

      <div className="topo-confidence">
        <div className="topo-confidence-top">
          <span>模型置信度</span>
          <strong>{confidence}%</strong>
        </div>
        <div className="topo-confidence-bar">
          <i style={{ width: `${confidence}%` }} />
        </div>
        <div className="topo-meta-grid">
          <span>
            窗口 <b>{windowLabel(graph.window.seconds)}</b>
          </span>
          <span>
            生成 <b>{relativeTime(analysis.generatedAt)}</b>
          </span>
          <span>
            节点 <b>{graph.stats.nodeCount}</b> · 链路 <b>{graph.stats.edgeCount}</b>
          </span>
          <span>
            连接 <b>{formatConnections(graph.stats.totalConnections)}</b>
          </span>
          <span>
            模型 <b>{fallback ? '规则引擎' : rawModel || '大模型'}</b>
          </span>
          <span>
            耗时 <b>{analysis.durationMs ? `${(analysis.durationMs / 1000).toFixed(1)}s` : '—'}</b>
          </span>
        </div>
      </div>

      {fallback ? (
        <p className="topo-analysis-warning">
          本次未获取到可用的模型结果，已自动使用规则引擎兜底生成，结论置信度可能略低。
        </p>
      ) : null}

      <section className="topo-rail-section">
        <div className="topo-rail-section-head">
          <h3>核心链路</h3>
          <span className="topo-rail-section-sub">点击在画布高亮</span>
          {activeHotPath !== null || activeInsightId ? (
            <button type="button" className="topo-rail-clear" onClick={onClear}>
              清除
            </button>
          ) : null}
        </div>
        <div className="topo-hotpaths">
          {analysis.hotPaths.map((path, index) => (
            <button
              key={path.label}
              type="button"
              className={`topo-hotpath${activeHotPath === index ? ' is-active' : ''}`}
              onClick={() => onHotPath(index)}
              title={`${path.label} · ${formatConnections(path.connections)} 连接`}
            >
              <span className="topo-hotpath-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="topo-hotpath-main">
                <span className="topo-hotpath-top">
                  <strong>{truncateText(path.label, 138, 12)}</strong>
                  <span className="topo-hotpath-count">{formatConnections(path.connections)} 连接</span>
                </span>
                <PathChain graph={graph} path={path} />
              </span>
              <MiniIcon name="arrow-right" size={13} />
            </button>
          ))}
        </div>
      </section>

      <section className="topo-rail-section">
        <div className="topo-rail-section-head">
          <h3>风险与洞察</h3>
          <span className="topo-rail-section-sub">{insights.length} 条</span>
        </div>
        <div className="topo-insights">
          {insights.map((insight) => (
            <button
              key={insight.id}
              type="button"
              className={`topo-insight is-${insight.severity}${activeInsightId === insight.id ? ' is-active' : ''}`}
              onClick={() => onInsight(insight)}
            >
              <span className={`topo-sev-dot is-${insight.severity}`} />
              <span className="topo-insight-main">
                <span className="topo-insight-title">
                  {insight.title}
                  <em className={`topo-sev-tag is-${insight.severity}`}>{SEVERITY_LABEL[insight.severity]}</em>
                </span>
                <span className="topo-insight-detail">{insight.detail}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {risks.length > 0 ? (
        <section className="topo-rail-section">
          <div className="topo-rail-section-head">
            <h3>链路风险</h3>
            <span className="topo-rail-section-sub">按影响排序</span>
          </div>
          <div className="topo-risks">
            {risks.map((risk) => (
              <button
                key={risk.id}
                type="button"
                className={`topo-risk is-${risk.severity}${activeInsightId === risk.id ? ' is-active' : ''}`}
                onClick={() => onInsight(risk)}
              >
                <span className={`topo-sev-dot is-${risk.severity}`} />
                <span>
                  <strong>{risk.title}</strong>
                  <span>{risk.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="topo-rail-foot">
        <span>
          <MiniIcon name="spark" size={12} /> {analysis.promptVersion}
        </span>
        <span>
          耗时 {analysis.durationMs ? `${(analysis.durationMs / 1000).toFixed(1)}s` : '—'} ·{' '}
          {relativeTime(analysis.generatedAt)}
        </span>
      </div>
    </div>
  );
}

export interface NodeDetailPanelProps {
  readonly node: PositionedNode;
  readonly view: ViewGraph;
  readonly graph: TopologyGraph;
  readonly systemColors: ReadonlyMap<string, string>;
  readonly onClose: () => void;
  readonly onFocus: () => void;
  readonly onSelectNode: (id: string) => void;
  readonly onOpenAgent: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  offline: '离线',
  unknown: '未上报',
};

export function NodeDetailPanel({
  node,
  view,
  graph,
  systemColors,
  onClose,
  onFocus,
  onSelectNode,
  onOpenAgent,
}: NodeDetailPanelProps): ReactElement {
  const labelById = new Map(view.nodes.map((item) => [item.node.id, item.node.label]));
  const systemColor = node.systemId ? systemColors.get(node.systemId) ?? node.systemColor : node.systemColor;
  const incoming = graph.edges.filter((edge) => edge.target === node.id);
  const outgoing = graph.edges.filter((edge) => edge.source === node.id);
  const anomalies = node.node.anomalies ?? [];
  return (
    <div className="topo-rail-scroll">
      <div className="topo-detail-head">
        <div className="topo-detail-avatar" style={{ color: systemColor, borderColor: `${systemColor}66`, background: `${systemColor}1f` }}>
          <KindIcon kind={node.node.kind} size={20} color={systemColor} />
        </div>
        <div className="topo-detail-titles">
          <div className="topo-rail-eyebrow">NODE INSPECTOR · 组件与节点详情</div>
          <h2 className="topo-rail-title">{node.node.label}</h2>
          <div className="topo-detail-sub">
            <span className="topo-status-pill" data-status={node.node.status}>
              <i />
              {STATUS_LABEL[node.node.status] ?? node.node.status}
            </span>
            {node.node.appSystemName ? <span className="topo-detail-system" style={{ color: systemColor }}>{node.node.appSystemName}</span> : null}
            {node.node.inferred ? <span className="topo-detail-inferred">模型推断</span> : null}
          </div>
        </div>
        <button type="button" className="topo-icon-btn" aria-label="关闭节点详情" onClick={onClose}>
          <MiniIcon name="close" size={15} />
        </button>
      </div>

      <div className="topo-detail-meta">
        <span>
          主机 <b className="mono">{node.node.hostname ?? '—'}</b>
        </span>
        <span>
          IP <b className="mono">{node.node.ip ?? '—'}</b>
        </span>
        {node.aggregated ? <span>聚合 <b>{node.hostCount} 台主机</b></span> : null}
      </div>

      <div className="topo-detail-metrics">
        {[
          { label: '活跃连接', value: formatConnections(node.node.metrics.active) },
          { label: '窗口新建', value: formatConnections(node.node.metrics.opened) },
          { label: '窗口关闭', value: formatConnections(node.node.metrics.closed) },
          { label: '失败连接', value: formatConnections(node.node.metrics.failed), danger: node.node.metrics.failed > 0 },
          { label: '入站连接', value: formatConnections(node.incoming) },
          { label: '出站连接', value: formatConnections(node.outgoing) },
        ].map((metric) => (
          <div key={metric.label} className="topo-detail-metric">
            <span>{metric.label}</span>
            <strong className={metric.danger ? 'is-danger' : ''}>{metric.value}</strong>
          </div>
        ))}
      </div>

      <section className="topo-rail-section">
        <div className="topo-rail-section-head">
          <h3>大模型识别结果</h3>
          <span className="topo-rail-section-sub">依据端口与进程证据</span>
        </div>
        <div className="topo-identify-grid">
          <div>
            <span>组件 / 产品</span>
            <strong style={{ color: productTone(node.node.product).fg }}>{displayProduct(node.node)}</strong>
          </div>
          <div>
            <span>架构角色</span>
            <strong>{node.node.role ?? '未识别'}</strong>
          </div>
          <div>
            <span>节点类型</span>
            <strong>{node.node.systemService ? '系统/运维服务' : kindLabel(node.node.kind)}</strong>
          </div>
        </div>
        <p className="topo-identify-note">
          大模型基于 Agent 采集的监听端口、进程名/命令行与建连证据识别组件和分层；模型不可用时由规则引擎兜底。
        </p>
      </section>

      <section className="topo-rail-section">
        <div className="topo-rail-section-head">
          <h3>监听服务</h3>
          <span className="topo-rail-section-sub">{node.node.services.length} 个端口</span>
        </div>
        <div className="topo-service-list">
          {node.node.services.length === 0 ? <p className="topo-rail-empty">该节点没有上报监听端口。</p> : null}
          {node.node.services.map((service) => (
            <div key={`${service.name}-${service.port}`} className="topo-service-row">
              <span className="topo-service-name">{service.name.replace(/:\d+$/, '') || '服务'}</span>
              <span className="topo-service-port mono">:{service.port}</span>
              <span className="topo-service-proc">{service.process ?? '—'}</span>
            </div>
          ))}
        </div>
      </section>

      {anomalies.length > 0 ? (
        <section className="topo-rail-section">
          <div className="topo-rail-section-head">
            <h3>异常信号</h3>
            <span className="topo-rail-section-sub">{anomalies.length} 条</span>
          </div>
          <div className="topo-detail-alerts">
            {anomalies.map((anomaly) => (
              <div key={anomaly} className="topo-detail-alert">
                <MiniIcon name="warning" size={13} />
                <span>{anomaly}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="topo-rail-section">
        <div className="topo-rail-section-head">
          <h3>入站链路</h3>
          <span className="topo-rail-section-sub">{incoming.length} 条</span>
        </div>
        <div className="topo-edge-list">
          {incoming.length === 0 ? <p className="topo-rail-empty">没有观测到入站连接。</p> : null}
          {incoming.map((edge) => (
            <button key={edge.id} type="button" className={`topo-edge-row${edge.failed > 0 ? ' is-warn' : ''}`} onClick={() => onSelectNode(edge.source)}>
              <span className="topo-edge-row-main">
                <strong>{labelById.get(edge.source) ?? edge.source}</strong>
                <span className="mono">
                  {edge.processes?.[0] ?? 'unknown'} → {node.node.services.find((service) => service.port === edge.port)?.name?.replace(/:\d+$/, '') ?? ''}:{edge.port}
                </span>
              </span>
              <span className="topo-edge-row-count">
                {formatConnections(edge.count)}
                {edge.failed > 0 ? <em>失败 {edge.failed}</em> : null}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="topo-rail-section">
        <div className="topo-rail-section-head">
          <h3>出站链路</h3>
          <span className="topo-rail-section-sub">{outgoing.length} 条</span>
        </div>
        <div className="topo-edge-list">
          {outgoing.length === 0 ? <p className="topo-rail-empty">没有观测到出站连接。</p> : null}
          {outgoing.map((edge) => (
            <button key={edge.id} type="button" className={`topo-edge-row${edge.failed > 0 ? ' is-warn' : ''}`} onClick={() => onSelectNode(edge.target)}>
              <span className="topo-edge-row-main">
                <strong>{labelById.get(edge.target) ?? edge.target}</strong>
                <span className="mono">
                  {edge.processes?.[0] ?? 'unknown'} → {labelById.get(edge.target) ?? edge.target}:{edge.port}
                </span>
              </span>
              <span className="topo-edge-row-count">
                {formatConnections(edge.count)}
                {edge.failed > 0 ? <em>失败 {edge.failed}</em> : null}
              </span>
            </button>
          ))}
        </div>
      </section>

      {node.node.note ? <p className="topo-detail-note">{node.node.note}</p> : null}

      <div className="topo-detail-actions">
        <button type="button" className="btn btn-outline btn-sm" onClick={onFocus}>
          <MiniIcon name="target" size={13} /> 聚焦上下游
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onOpenAgent}>
          <MiniIcon name="arrow-right" size={13} /> 在操作系统智能体中查看
        </button>
      </div>
    </div>
  );
}
