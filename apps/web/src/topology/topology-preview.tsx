import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { TopologyEdgeTag, TopologyGraph } from '@opsagent/contracts';
import { getLatestTopology } from '../api/client.js';
import { filterGraphByScope } from './v3.js';
import { buildViewGraph, computeLayout, isExternalNode } from './layout.js';
import { TopologyCanvas } from './topology-canvas.js';
import '../routes/topology.css';

export interface TopologyPreviewProps {
  readonly appSystemId: string;
  readonly appSystemName: string;
}

/**
 * 操作系统智能体页内嵌的访问关系拓扑：
 * 复用「访问拓扑」最新版本图，按应用系统裁剪，并移除所有外部依赖节点/边。
 */
function pruneExternalDependencies(graph: TopologyGraph): TopologyGraph {
  const keep = new Set(
    graph.nodes
      .filter((node) => !isExternalNode(node) && node.kind !== 'external' && !node.id.startsWith('scope-sys:'))
      .map((node) => node.id),
  );
  const nodes = graph.nodes.filter((node) => keep.has(node.id));
  const edges = graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target));
  return {
    ...graph,
    nodes,
    edges,
    stats: {
      ...graph.stats,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      hostCount: nodes.filter((node) => !node.inferred).length,
      externalCount: 0,
    },
  };
}

export function TopologyPreview({ appSystemId, appSystemName }: TopologyPreviewProps): ReactElement {
  const [graph, setGraph] = useState<TopologyGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setGraph(null);
    setSelectedId(null);
    setFocusId(null);
    void getLatestTopology()
      .then((latest) => {
        if (cancelled) return;
        if (!latest) {
          setGraph(null);
          return;
        }
        setGraph(pruneExternalDependencies(filterGraphByScope(latest, appSystemId)));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appSystemId]);

  const view = useMemo(
    () => (graph ? buildViewGraph(graph, 'host', { includeUnassigned: false }) : null),
    [graph],
  );
  const layout = useMemo(() => (view ? computeLayout(view) : null), [view]);
  const tagsByRelation = useMemo(() => {
    const map = new Map<string, TopologyEdgeTag[]>();
    for (const edge of graph?.edges ?? []) {
      if (!edge.tags?.length) continue;
      const relationKey = edge.relationKey ?? edge.id;
      map.set(relationKey, [...edge.tags]);
    }
    return map;
  }, [graph]);

  return (
    <div className="topology-preview">
      <div className="topology-preview-head">
        <div>
          <strong>{appSystemName} · 内部访问关系</strong>
          <span>来自「访问拓扑」最新版本 · 已隐藏外部依赖</span>
        </div>
        {graph ? (
          <span className="badge badge-neutral">
            {graph.nodes.length} 节点 · {graph.edges.length} 链路
          </span>
        ) : null}
      </div>
      <div className="topology-preview-canvas">
        {loading ? <div className="topology-preview-state">正在加载访问拓扑…</div> : null}
        {!loading && failed ? (
          <div className="topology-preview-state is-bad">访问拓扑加载失败，请稍后重试。</div>
        ) : null}
        {!loading && !failed && (!graph || graph.nodes.length === 0) ? (
          <div className="topology-preview-state">
            该应用系统还没有内部访问关系。请先在「访问拓扑」完成一次学习。
          </div>
        ) : null}
        {!loading && !failed && graph && view && layout && graph.nodes.length > 0 ? (
          <TopologyCanvas
            view={view}
            layout={layout}
            selectedId={selectedId}
            focusId={focusId}
            analysisNodeIds={null}
            analysisEdgeIds={null}
            drillSystemId={null}
            search=""
            filterAnomaly={false}
            filterCross={false}
            centerTarget={null}
            showEdgeLabels={false}
            fitEpoch={0}
            resetEpoch={0}
            edgeTags={tagsByRelation}
            highlightRelationKey={null}
            adjustmentOffsets={{}}
            onSelect={(id) => {
              setSelectedId(id);
              setFocusId(id);
            }}
            onFocus={(id) => setFocusId(id)}
            onDrill={() => {}}
            onHoverNode={() => {}}
          />
        ) : null}
      </div>
    </div>
  );
}
