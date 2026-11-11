import { useState, type ReactElement } from 'react';
import type { TopologyGraph, TopologyHotPath, TopologyInsight, TopologyServicePort, TopologyEdgeTag } from '@opsagent/contracts';
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
import type { ExternalGroupInfo, RelatedNode } from './v3.js';
import { KindIcon, MiniIcon } from './icons.js';

export interface AnalysisPanelProps {
  readonly graph: TopologyGraph;
  readonly activeHotPath: number | null;
  readonly activeInsightId: string | null;
  readonly onHotPath: (index: number) => void;
  readonly onInsight: (insight: TopologyInsight) => void;
  readonly onClear: () => void;
  readonly onOpenModels: () => void;
  readonly canReanalyze?: boolean;
  readonly reanalyzing?: boolean;
  readonly onReanalyze?: () => void;
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

function PathChain({ graph, path, maxWidth = 220 }: { graph: TopologyGraph; path: TopologyHotPath; maxWidth?: number }): ReactElement {
  const full = path.nodeIds.map((id) => nodeLabel(graph, id)).join(' → ');
  return (
    <span className="topo-hotpath-chain" title={full}>
      {truncateText(full, maxWidth, 11)}
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
  onOpenModels,
  canReanalyze = false,
  reanalyzing = false,
  onReanalyze,
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
  const shortModel = modelLabel.length > 18 ? `${modelLabel.slice(0, 18)}…` : modelLabel;

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

      {fallback ? (
        <div className="topo-fallback-notice">
          <div className="topo-fallback-head">
            <MiniIcon name="warning" size={14} />
            <strong>当前为规则引擎兜底生成</strong>
          </div>
          <p>
            在「模型配置」添加 OpenAI / Anthropic 兼容模型后重新学习，将由大模型基于提示词识别组件与分层。
          </p>
          <button type="button" className="btn btn-outline btn-sm" onClick={onOpenModels}>
            <MiniIcon name="settings" size={12} /> 去模型配置
          </button>
          {canReanalyze && onReanalyze ? (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={reanalyzing}
              onClick={onReanalyze}
              style={{ marginTop: 8 }}
            >
              <MiniIcon name="refresh" size={12} /> {reanalyzing ? '重新分析中…' : '用当前模型重新分析'}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="topo-model-line">
          <MiniIcon name="spark" size={12} /> 大模型生成 · <b>{modelLabel}</b> · prompt <b>{analysis.promptVersion}</b>
        </div>
      )}

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

      {analysis.warning ? <p className="topo-analysis-warning">{analysis.warning}</p> : null}
      {analysis.fallbackReason ? (
        <p className="topo-analysis-warning">模型调用失败原因：{analysis.fallbackReason}</p>
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
  readonly services: { business: readonly TopologyServicePort[]; management: readonly TopologyServicePort[] };
  readonly relatedNodes: { outgoing: readonly RelatedNode[]; incoming: readonly RelatedNode[] };
  readonly externalGroup: ExternalGroupInfo | null;
  readonly tagsByRelation: ReadonlyMap<string, readonly TopologyEdgeTag[]>;
  readonly keepFullView: boolean;
  readonly onClose: () => void;
  readonly onFocus: () => void;
  readonly onNavigate: (id: string) => void;
  readonly onToggleKeepFullView: () => void;
  readonly onReturnFull: () => void;
  readonly onFullscreen: () => void;
  readonly onOpenAgent: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  offline: '离线',
  unknown: '未上报',
};

function ServiceRows({ services }: { services: readonly TopologyServicePort[] }): ReactElement {
  return (
    <div className="topo-service-list">
      {services.length === 0 ? <p className="topo-rail-empty">暂无。</p> : null}
      {services.map((service) => (
        <div key={`${service.name}-${service.port}`} className="topo-service-row">
          <span className="topo-service-name">{service.name.replace(/:\d+$/, '') || '服务'}</span>
          <span className="topo-service-port mono">:{service.port}</span>
          <span className="topo-service-proc">{service.process ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}

function RelatedList({
  title,
  items,
  tagsByRelation,
  onNavigate,
}: {
  title: string;
  items: readonly RelatedNode[];
  tagsByRelation: ReadonlyMap<string, readonly TopologyEdgeTag[]>;
  onNavigate: (id: string) => void;
}): ReactElement {
  return (
    <section className="topo-rail-section">
      <div className="topo-rail-section-head">
        <h3>{title}</h3>
        <span className="topo-rail-section-sub">{items.length} 个节点</span>
      </div>
      <div className="topo-related-list">
        {items.length === 0 ? <p className="topo-rail-empty">暂无关联节点。</p> : null}
        {items.map((item) => (
          <button key={item.nodeId} type="button" className="topo-related-row" onClick={() => onNavigate(item.nodeId)}>
            <span className="topo-related-main">
              <strong>{item.label}</strong>
              <span className="topo-related-sub">
                {item.role}
                {item.ports.length > 0 ? ` · :${item.ports.slice(0, 4).join('/')}` : ''}
              </span>
              {(() => {
                const tagged = [...new Map(
                  item.relationKeys
                    .flatMap((key) => tagsByRelation.get(key) ?? [])
                    .map((tag) => [tag.label, tag]),
                ).values()];
                return tagged.length > 0 ? (
                  <span className="topo-v4-tagchips">
                    {tagged.map((tag) => (
                      <em key={tag.id || tag.label} className="topo-v4-tagchip" style={{ color: tag.color ?? '#3d7ab8', borderColor: `${tag.color ?? '#3d7ab8'}55`, background: `${tag.color ?? '#3d7ab8'}14` }}>
                        {tag.label}
                      </em>
                    ))}
                  </span>
                ) : null;
              })()}
            </span>
            <span className="topo-related-count">
              {formatConnections(item.connections)}
              {item.failed > 0 ? <em>失败 {item.failed}</em> : null}
            </span>
            <MiniIcon name="chevron-right" size={12} />
          </button>
        ))}
      </div>
    </section>
  );
}

export function NodeDetailPanel({
  node,
  view,
  graph,
  systemColors,
  services,
  relatedNodes,
  externalGroup,
  tagsByRelation,
  keepFullView,
  onClose,
  onFocus,
  onNavigate,
  onToggleKeepFullView,
  onReturnFull,
  onFullscreen,
  onOpenAgent,
}: NodeDetailPanelProps): ReactElement {
  const systemColor = node.systemId ? systemColors.get(node.systemId) ?? node.systemColor : node.systemColor;
  const anomalies = node.node.anomalies ?? [];
  const [activeTargetIp, setActiveTargetIp] = useState<string | null>(null);
  const product = displayProduct(node.node);
  const tone = productTone(node.node.product);
  return (
    <div className="topo-rail-scroll">
      <div className="topo-detail-head">
        <div className="topo-detail-avatar" style={{ color: systemColor, borderColor: `${systemColor}66`, background: `${systemColor}1f` }}>
          <KindIcon kind={node.node.kind} size={20} color={systemColor} />
        </div>
        <div className="topo-detail-titles">
          <div className="topo-rail-eyebrow">NODE INSPECTOR · 节点与关系</div>
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
          <h3>组件识别</h3>
          <span className="topo-rail-section-sub">大模型 / 规则引擎</span>
        </div>
        <div className="topo-identify-grid">
          <div>
            <span>组件 / 产品</span>
            <strong style={{ color: tone.fg }}>{product}</strong>
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
      </section>

      {externalGroup ? (
        <section className="topo-rail-section">
          <div className="topo-rail-section-head">
            <h3>{externalGroup.isAggregate ? '全部外部目标' : '外部目标'}</h3>
            <span className="topo-rail-section-sub">{externalGroup.targets.length} 个 IP</span>
          </div>
          <div className="topo-external-targets">
            {externalGroup.targets.map((target) => (
              <button
                key={target.ip}
                type="button"
                className={`topo-external-target${activeTargetIp === target.ip ? ' is-active' : ''}`}
                onClick={() => {
                  setActiveTargetIp(target.ip);
                  onNavigate(node.id);
                }}
              >
                <span className="topo-external-main">
                  <strong className="mono">{target.ip}</strong>
                  <span>{target.hostname && target.hostname !== target.ip ? target.hostname : '外部 IP'}</span>
                </span>
                <span className="topo-external-ports">
                  {target.ports.slice(0, 5).map((port) => (
                    <em key={`${target.ip}-${port.port}`}>:{port.port}</em>
                  ))}
                  {target.ports.length > 5 ? <em>+{target.ports.length - 5}</em> : null}
                </span>
                <span className="topo-related-count">
                  {formatConnections(target.connections)}
                  {target.failed > 0 ? <em>失败 {target.failed}</em> : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="topo-rail-section">
        <div className="topo-rail-section-head">
          <h3>业务服务</h3>
          <span className="topo-rail-section-sub">{services.business.length} 个端口</span>
        </div>
        <ServiceRows services={services.business} />
      </section>

      <section className="topo-rail-section">
        <div className="topo-rail-section-head">
          <h3>系统管理服务</h3>
          <span className="topo-rail-section-sub">{services.management.length} 个端口</span>
        </div>
        <ServiceRows services={services.management} />
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

      <RelatedList title="出站关联" items={relatedNodes.outgoing} tagsByRelation={tagsByRelation} onNavigate={onNavigate} />
      <RelatedList title="入站关联" items={relatedNodes.incoming} tagsByRelation={tagsByRelation} onNavigate={onNavigate} />

      {node.node.note ? <p className="topo-detail-note">{node.node.note}</p> : null}
      {!node.aggregated && view.mode === 'host' ? (
        <p className="topo-detail-note">
          点击上方关联节点可切换详情；画布会自动聚焦该节点的上下游关系。使用「保持全图」可取消自动缩放。
        </p>
      ) : null}

      <div className="topo-detail-actions">
        <button type="button" className="btn btn-outline btn-sm" onClick={onReturnFull}>
          <MiniIcon name="fit" size={13} /> 返回全图
        </button>
        <button type="button" className={`btn btn-outline btn-sm${keepFullView ? ' is-on' : ''}`} onClick={onToggleKeepFullView}>
          <MiniIcon name="target" size={13} /> {keepFullView ? '已保持全图' : '保持全图'}
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={onFocus}>
          <MiniIcon name="target" size={13} /> 聚焦上下游
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={onFullscreen}>
          <MiniIcon name="fit" size={13} /> 全屏查看
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onOpenAgent}>
          <MiniIcon name="arrow-right" size={13} /> 在操作系统智能体中查看
        </button>
      </div>
    </div>
  );
}
