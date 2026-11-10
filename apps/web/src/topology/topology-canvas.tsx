import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import {
  SYSTEM_COLORS,
  TIER_META,
  matchNodeIds,
  measureText,
  type RoutedEdge,
  type TopoLayout,
  type ViewGraph,
} from './layout.js';
import { EdgePath } from './edge-path.js';
import { NodeCard } from './node-card.js';
import { MiniIcon, TierIcon } from './icons.js';

const MIN_K = 0.3;
const MAX_K = 3;

interface Emphasis {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  readonly hard: boolean;
  readonly label: string;
}

export interface CenterTarget {
  readonly ids: readonly string[];
  readonly epoch: number;
}

export interface TopologyCanvasProps {
  readonly view: ViewGraph;
  readonly layout: TopoLayout;
  readonly selectedId: string | null;
  readonly focusId: string | null;
  readonly analysisNodeIds: readonly string[] | null;
  readonly analysisEdgeIds: readonly string[] | null;
  readonly drillSystemId: string | null;
  readonly search: string;
  readonly filterAnomaly: boolean;
  readonly filterCross: boolean;
  readonly centerTarget: CenterTarget | null;
  readonly onSelect: (id: string | null) => void;
  readonly onFocus: (id: string | null) => void;
  readonly onDrill: (systemId: string) => void;
  readonly onHoverNode: (id: string | null) => void;
}

interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly originX: number;
  readonly originY: number;
  moved: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function gradientIdOf(edgeId: string): string {
  return `topo2-g-${edgeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function markerIdOf(edge: RoutedEdge): string {
  if (edge.anomalous) return 'topo2-arrow-danger';
  if (edge.external) return 'topo2-arrow-external';
  const index = SYSTEM_COLORS.indexOf(edge.colorB);
  return index >= 0 ? `topo2-arrow-s${index}` : 'topo2-arrow-external';
}

function cubicPointOfEdge(edge: RoutedEdge, t: number): { x: number; y: number } {
  const values = edge.d
    .replace(/[MC,]/g, ' ')
    .trim()
    .split(/\s+/)
    .map((value) => Number(value));
  const [sx = 0, sy = 0, c1x = 0, c1y = 0, c2x = 0, c2y = 0, tx = 0, ty = 0] = values;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * sx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * tx,
    y: mt * mt * mt * sy + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ty,
  };
}

function neighborIds(layout: TopoLayout, nodeId: string): { nodes: Set<string>; edges: Set<string>; label: string } {
  const nodes = new Set<string>([nodeId]);
  const edges = new Set<string>();
  for (const edge of layout.edges) {
    if (edge.sourceId === nodeId || edge.targetId === nodeId) {
      nodes.add(edge.sourceId);
      nodes.add(edge.targetId);
      edges.add(edge.edge.id);
    }
  }
  return { nodes, edges, label: '1 跳上下游' };
}

export function TopologyCanvas(props: TopologyCanvasProps): ReactElement {
  const {
    view,
    layout,
    selectedId,
    focusId,
    analysisNodeIds,
    analysisEdgeIds,
    drillSystemId,
    search,
    filterAnomaly,
    filterCross,
    centerTarget,
    onSelect,
    onFocus,
    onDrill,
    onHoverNode,
  } = props;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const gRef = useRef<SVGGElement | null>(null);
  const miniViewportRef = useRef<SVGRectElement | null>(null);
  const miniSvgRef = useRef<SVGSVGElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  const layoutRef = useRef<TopoLayout | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, k: 0.6 });
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [detailZoom, setDetailZoom] = useState(false);
  const [zoomK, setZoomK] = useState(0.8);

  const miniWidth = 150;
  const miniHeight = useMemo(
    () => clamp((miniWidth * layout.height) / Math.max(1, layout.width), 58, 104),
    [layout.height, layout.width],
  );
  const laneHeaderW = layout.columns[0]?.x ?? 150;

  layoutRef.current = layout;
  sizeRef.current = size;

  const applyView = useCallback((): void => {
    const transform = transformRef.current;
    gRef.current?.setAttribute(
      'transform',
      `translate(${transform.x.toFixed(2)} ${transform.y.toFixed(2)}) scale(${transform.k.toFixed(4)})`,
    );
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(transform.k * 100)}%`;
    const detail = transform.k >= 1.5;
    setDetailZoom((previous) => (previous === detail ? previous : detail));
    setZoomK((previous) => (Math.abs(previous - transform.k) > 0.002 ? transform.k : previous));
    const viewport = miniViewportRef.current;
    const current = layoutRef.current;
    const currentSize = sizeRef.current;
    if (viewport && current && miniSvgRef.current) {
      const scale = miniWidth / Math.max(1, current.width);
      viewport.setAttribute('x', ((-transform.x / transform.k) * scale).toFixed(2));
      viewport.setAttribute('y', ((-transform.y / transform.k) * scale).toFixed(2));
      viewport.setAttribute('width', ((currentSize.w / transform.k) * scale).toFixed(2));
      viewport.setAttribute('height', ((currentSize.h / transform.k) * scale).toFixed(2));
    }
  }, [miniWidth]);

  const viewToFit = useCallback((minScale: number): void => {
    const current = layoutRef.current;
    const currentSize = sizeRef.current;
    if (!current || currentSize.w === 0 || currentSize.h === 0) return;
    const pad = 20;
    const fitK = Math.min(
      (currentSize.w - pad * 2) / current.width,
      (currentSize.h - pad * 2) / current.height,
    );
    const k = clamp(Math.max(fitK, minScale), MIN_K, 1.06);
    const floored = k > fitK + 0.001;
    transformRef.current = {
      k,
      // 放大后的默认视图从左上开始，先保证泳道名和层列头可见，再靠平移看全图。
      x: floored ? 16 : (currentSize.w - current.width * k) / 2,
      y: floored ? 12 : (currentSize.h - current.height * k) / 2,
    };
    applyView();
  }, [applyView]);

  const fitView = useCallback((): void => viewToFit(MIN_K), [viewToFit]);
  // 首次打开完整显示 6 个分层与全部泳道；用户可用 +/− 或 1:1 放大看细节。
  const initialView = useCallback((): void => viewToFit(MIN_K), [viewToFit]);

  const resetZoom = useCallback((): void => {
    const current = layoutRef.current;
    const currentSize = sizeRef.current;
    if (!current) return;
    const k = 1;
    transformRef.current = {
      k,
      x: (currentSize.w - current.width * k) / 2,
      y: Math.max(16, (currentSize.h - current.height * k) / 2),
    };
    applyView();
  }, [applyView]);

  const zoomAt = useCallback(
    (nextK: number, px: number, py: number): void => {
      const current = transformRef.current;
      const k = clamp(nextK, MIN_K, MAX_K);
      const scale = k / current.k;
      transformRef.current = {
        k,
        x: px - (px - current.x) * scale,
        y: py - (py - current.y) * scale,
      };
      applyView();
    },
    [applyView],
  );

  const centerOn = useCallback(
    (ids: readonly string[]): void => {
      const current = layoutRef.current;
      const currentSize = sizeRef.current;
      if (!current || currentSize.w === 0) return;
      const targets = ids.map((id) => current.nodeById.get(id)).filter((node) => node !== undefined);
      if (targets.length === 0) return;
      const minX = Math.min(...targets.map((node) => node.x));
      const maxX = Math.max(...targets.map((node) => node.x + node.w));
      const minY = Math.min(...targets.map((node) => node.y));
      const maxY = Math.max(...targets.map((node) => node.y + node.h));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const k = clamp(
        Math.min(currentSize.w / (maxX - minX + 320), currentSize.h / (maxY - minY + 260), 1.5),
        0.6,
        1.5,
      );
      transformRef.current = {
        k,
        x: currentSize.w / 2 - centerX * k,
        y: currentSize.h / 2 - centerY * k,
      };
      applyView();
    },
    [applyView],
  );

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;
      setSize((previous) => (previous.w === width && previous.h === height ? previous : { w: width, h: height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    initialView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, layout.width, layout.height]);

  useEffect(() => {
    applyView();
  }, [applyView, layout, miniHeight, minimapOpen]);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0016);
      zoomAt(transformRef.current.k * factor, px, py);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  useEffect(() => {
    if (!centerTarget) return;
    if (centerTarget.ids.length === 0) return;
    centerOn(centerTarget.ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerTarget?.epoch, layout]);

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transformRef.current.x,
      originY: transformRef.current.y,
      moved: false,
    };
    suppressClickRef.current = false;
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      drag.moved = true;
      suppressClickRef.current = true;
    }
    if (!drag.moved) return;
    transformRef.current = { ...transformRef.current, x: drag.originX + dx, y: drag.originY + dy };
    applyView();
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
  };

  useEffect(() => {
    const clearDrag = (): void => {
      dragRef.current = null;
    };
    window.addEventListener('pointerup', clearDrag);
    window.addEventListener('pointercancel', clearDrag);
    return () => {
      window.removeEventListener('pointerup', clearDrag);
      window.removeEventListener('pointercancel', clearDrag);
    };
  }, []);

  const handleBackgroundClick = (): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelect(null);
    onFocus(null);
  };

  const onMiniPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const moveTo = (clientX: number, clientY: number): void => {
      const svg = miniSvgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const worldX = ((clientX - rect.left) / Math.max(1, rect.width)) * layout.width;
      const worldY = ((clientY - rect.top) / Math.max(1, rect.height)) * layout.height;
      const currentSize = sizeRef.current;
      transformRef.current = {
        ...transformRef.current,
        x: currentSize.w / 2 - worldX * transformRef.current.k,
        y: currentSize.h / 2 - worldY * transformRef.current.k,
      };
      applyView();
    };
    moveTo(event.clientX, event.clientY);
    const onMove = (moveEvent: PointerEvent): void => moveTo(moveEvent.clientX, moveEvent.clientY);
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleNodeSelect = useCallback(
    (id: string): void => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const node = layoutRef.current?.nodeById.get(id);
      if (node?.aggregated) {
        const systemId = node.node.appSystemId;
        if (systemId) onDrill(systemId);
        else onSelect(id);
        return;
      }
      onSelect(id);
    },
    [onDrill, onSelect],
  );

  const handleNodeFocus = useCallback(
    (id: string): void => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const node = layoutRef.current?.nodeById.get(id);
      if (node?.aggregated) {
        const systemId = node.node.appSystemId;
        if (systemId) onDrill(systemId);
        return;
      }
      onFocus(focusId === id ? null : id);
    },
    [focusId, onDrill, onFocus],
  );

  const handleHoverNode = useCallback(
    (id: string | null): void => {
      setHoveredNodeId(id);
      onHoverNode(id);
    },
    [onHoverNode],
  );

  const handleHoverEdge = useCallback((id: string | null): void => {
    setHoveredEdgeId(id);
  }, []);

  const analysisEmphasis = useMemo<Emphasis | null>(() => {
    const hasNodes = (analysisNodeIds?.length ?? 0) > 0;
    const hasEdges = (analysisEdgeIds?.length ?? 0) > 0;
    if (!hasNodes && !hasEdges) return null;
    const nodes = new Set<string>(analysisNodeIds ?? []);
    const edges = new Set<string>(analysisEdgeIds ?? []);
    for (const edge of layout.edges) {
      if (edges.has(edge.edge.id)) {
        nodes.add(edge.sourceId);
        nodes.add(edge.targetId);
      }
    }
    return { nodes, edges, hard: true, label: '分析聚焦' };
  }, [analysisEdgeIds, analysisNodeIds, layout.edges]);

  const drillEmphasis = useMemo<Emphasis | null>(() => {
    if (!drillSystemId) return null;
    const nodes = new Set<string>();
    for (const node of layout.nodes) {
      if (view.mode === 'system' ? node.node.appSystemId === drillSystemId : node.systemId === drillSystemId) {
        nodes.add(node.id);
      }
    }
    return { nodes, edges: new Set(), hard: true, label: '业务系统聚焦' };
  }, [drillSystemId, layout.nodes, view.mode]);

  const emphasis = useMemo<Emphasis | null>(() => {
    if (hoveredEdgeId) {
      const edge = layout.edgeById.get(hoveredEdgeId);
      if (edge) {
        return { nodes: new Set([edge.sourceId, edge.targetId]), edges: new Set([edge.edge.id]), hard: false, label: edge.fullLabel };
      }
    }
    if (hoveredNodeId) {
      const neighbor = neighborIds(layout, hoveredNodeId);
      return { nodes: neighbor.nodes, edges: neighbor.edges, hard: true, label: neighbor.label };
    }
    if (focusId) {
      const neighbor = neighborIds(layout, focusId);
      return { nodes: neighbor.nodes, edges: neighbor.edges, hard: true, label: neighbor.label };
    }
    if (analysisEmphasis) return analysisEmphasis;
    if (drillEmphasis) return drillEmphasis;
    if (selectedId) {
      const neighbor = neighborIds(layout, selectedId);
      return { nodes: neighbor.nodes, edges: neighbor.edges, hard: false, label: '选中节点' };
    }
    return null;
  }, [analysisEmphasis, drillEmphasis, focusId, hoveredEdgeId, hoveredNodeId, layout, selectedId]);

  const searchQuery = search.trim().toLowerCase();
  const matchedNodeIds = useMemo<ReadonlySet<string>>(
    () => (searchQuery ? matchNodeIds(layout, search) : new Set<string>()),
    [layout, search, searchQuery],
  );
  const searching = searchQuery.length > 0;

  const filtersActive = filterAnomaly || filterCross;
  const allowedEdges = useMemo<ReadonlySet<string>>(() => {
    if (!filtersActive) return new Set();
    const allowed = new Set<string>();
    for (const edge of layout.edges) {
      if (filterAnomaly && !edge.anomalous) continue;
      if (filterCross && !edge.crossSystem) continue;
      allowed.add(edge.edge.id);
    }
    return allowed;
  }, [filterAnomaly, filterCross, filtersActive, layout.edges]);
  const allowedNodes = useMemo<ReadonlySet<string>>(() => {
    if (!filtersActive) return new Set();
    const allowed = new Set<string>();
    for (const edge of layout.edges) {
      if (!allowedEdges.has(edge.edge.id)) continue;
      allowed.add(edge.sourceId);
      allowed.add(edge.targetId);
    }
    return allowed;
  }, [allowedEdges, filtersActive, layout.edges]);

  const isNodeDimmed = (nodeId: string): boolean => {
    if (emphasis && !emphasis.nodes.has(nodeId)) return true;
    if (filtersActive && !allowedNodes.has(nodeId)) return true;
    if (searching && !matchedNodeIds.has(nodeId)) return true;
    return false;
  };

  const isEdgeDimmed = (edge: RoutedEdge): boolean => {
    if (emphasis && !emphasis.edges.has(edge.edge.id)) return true;
    if (filtersActive && !allowedEdges.has(edge.edge.id)) return true;
    if (searching && !matchedNodeIds.has(edge.sourceId) && !matchedNodeIds.has(edge.targetId)) return true;
    return false;
  };

  const activeEdgeIds = useMemo<ReadonlySet<string>>(() => {
    const active = new Set<string>();
    if (hoveredEdgeId) active.add(hoveredEdgeId);
    if (emphasis) for (const id of emphasis.edges) active.add(id);
    return active;
  }, [emphasis, hoveredEdgeId]);

  const sortedEdges = useMemo(() => {
    const inactive = layout.edges.filter((edge) => !activeEdgeIds.has(edge.edge.id));
    const active = layout.edges.filter((edge) => activeEdgeIds.has(edge.edge.id));
    return [...inactive, ...active];
  }, [activeEdgeIds, layout.edges]);

  const sortedNodes = useMemo(() => {
    const nodeId = focusId ?? hoveredNodeId ?? selectedId;
    const active = new Set<string>();
    if (nodeId) {
      active.add(nodeId);
      for (const id of neighborIds(layout, nodeId).nodes) active.add(id);
    }
    return [...layout.nodes.filter((node) => !active.has(node.id)), ...layout.nodes.filter((node) => active.has(node.id))];
  }, [focusId, hoveredNodeId, layout, selectedId]);

  const activeLabels = useMemo(() => {
    const ids = new Set<string>();
    if (hoveredEdgeId) ids.add(hoveredEdgeId);
    if (hoveredNodeId) {
      for (const edge of layout.edges) {
        if (edge.sourceId === hoveredNodeId || edge.targetId === hoveredNodeId) ids.add(edge.edge.id);
      }
    }
    if (focusId) {
      for (const edge of layout.edges) {
        if (edge.sourceId === focusId || edge.targetId === focusId) ids.add(edge.edge.id);
      }
    }
    if (selectedId && ids.size === 0) {
      for (const edge of layout.edges) {
        if (edge.sourceId === selectedId || edge.targetId === selectedId) ids.add(edge.edge.id);
      }
    }
    if (ids.size === 0 && analysisEdgeIds) {
      for (const id of analysisEdgeIds) ids.add(id);
    }
    const chosen = [...ids]
      .map((id) => layout.edgeById.get(id))
      .filter((edge) => edge !== undefined)
      .slice(0, 8);
    // 标签按屏幕像素排布（缩小时不糊、放大时不变形），沿垂直方向错开避免互相重叠。
    return chosen.map((edge, index) => ({
      edge,
      offset: (index - (chosen.length - 1) / 2) * 24,
      w: Math.round(measureText(edge.fullLabel, 11.5) + 18),
      h: 20,
    }));
  }, [analysisEdgeIds, focusId, hoveredEdgeId, hoveredNodeId, layout, selectedId]);

  const gradientEdges = useMemo(
    () => layout.edges.filter((edge) => edge.crossSystem && !edge.external && !edge.anomalous),
    [layout.edges],
  );
  const animatedLimit = layout.edges.length > 80 ? 30 : 28;

  return (
    <div
      className={`topo2-canvas${view.mode === 'system' ? ' is-system-view' : ''}${hoveredNodeId || hoveredEdgeId ? ' is-hovering' : ''}${detailZoom ? ' is-detail-zoom' : ''}`}
      ref={wrapRef}
    >
      <svg
        className="topo2-canvas-svg"
        width="100%"
        height="100%"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleBackgroundClick}
        onDoubleClick={() => onFocus(null)}
        role="application"
        aria-label="业务访问拓扑画布"
      >
        <defs>
          <pattern id="topo2-grid" width="22" height="22" patternUnits="userSpaceOnUse">
            <path className="topo2-grid-line" d="M 22 0 L 0 0 0 22" fill="none" strokeWidth="1" />
          </pattern>
          {SYSTEM_COLORS.map((color, index) => (
            <marker
              key={`marker-${color}`}
              id={`topo2-arrow-s${index}`}
              markerWidth="8"
              markerHeight="8"
              refX="6.6"
              refY="4"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0.5 0.8 L7.6 4 L0.5 7.2 Z" fill={color} />
            </marker>
          ))}
          <marker id="topo2-arrow-danger" markerWidth="9" markerHeight="9" refX="7.4" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0.5 0.8 L8.2 4.5 L0.5 8.2 Z" fill="#dc5a5a" />
          </marker>
          <marker id="topo2-arrow-external" markerWidth="8" markerHeight="8" refX="6.6" refY="4" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0.5 0.8 L7.6 4 L0.5 7.2 Z" fill="#8a94a6" />
          </marker>
          {gradientEdges.map((edge) => (
            <linearGradient
              key={edge.edge.id}
              id={gradientIdOf(edge.edge.id)}
              gradientUnits="userSpaceOnUse"
              x1={edge.ax}
              y1={edge.ay}
              x2={edge.bx}
              y2={edge.by}
            >
              <stop offset="0" stopColor={edge.colorA} stopOpacity="0.75" />
              <stop offset="1" stopColor={edge.colorB} stopOpacity="0.85" />
            </linearGradient>
          ))}
        </defs>

        <rect className="topo2-canvas-bg" width="100%" height="100%" />
        <rect width="100%" height="100%" fill="url(#topo2-grid)" />

        <g ref={gRef}>
          {view.mode === 'host' ? (
            <>
              <rect className="topo2-header-bg" x={0} y={0} width={layout.width} height={layout.headerHeight} />
              <text className="topo2-corner-title" x={14} y={28}>
                业务系统 / 泳道
              </text>
              <text className="topo2-corner-sub" x={14} y={45}>
                共 {layout.lanes.length} 条泳道 · 6 个 IT 分层
              </text>
              {layout.columns.map((column, index) => (
                <g key={column.id} className="topo2-column-head">
                  <g transform={`translate(${column.x + 12} 14)`}>
                    <TierIcon tier={column.key} size={16} color={column.accent} strokeWidth={1.7} />
                  </g>
                  <text className="topo2-column-title" x={column.x + 34} y={26}>
                    {column.title}
                  </text>
                  <text className="topo2-column-en" x={column.x + 34} y={40}>
                    {column.en}
                  </text>
                  <text className="topo2-column-hint" x={column.x + 12} y={55}>
                    {column.hint}
                  </text>
                  <rect className="topo2-column-count-bg" x={column.x + column.w - 36} y={14} width={24} height={16} rx={5} />
                  <text className="topo2-column-count" x={column.x + column.w - 24} y={25.5} textAnchor="middle">
                    {column.count}
                  </text>
                  {index > 0 ? (
                    <line
                      className="topo2-column-divider"
                      x1={column.x - 6}
                      y1={layout.headerHeight}
                      x2={column.x - 6}
                      y2={layout.height - 8}
                    />
                  ) : null}
                </g>
              ))}
              <line className="topo2-header-line" x1={0} y1={layout.headerHeight} x2={layout.width} y2={layout.headerHeight} />
              <line className="topo2-lane-header-line" x1={laneHeaderW} y1={layout.headerHeight} x2={laneHeaderW} y2={layout.height - 8} />
              {layout.lanes.map((lane, index) => (
                <g key={lane.id} className={`topo2-lane${index % 2 === 1 ? ' is-alt' : ''}`}>
                  <rect className="topo2-lane-bg" x={0} y={lane.y} width={lane.w} height={lane.h} />
                  <rect className="topo2-lane-tint" x={laneHeaderW} y={lane.y} width={lane.w - laneHeaderW} height={lane.h} fill={lane.color} />
                  <line className="topo2-lane-line" x1={0} y1={lane.y + lane.h} x2={lane.w} y2={lane.y + lane.h} />
                  <rect className="topo2-lane-color" x={14} y={lane.y + 16} width={3.5} height={lane.h - 32} rx={1.8} fill={lane.color} />
                  <text className="topo2-lane-name" x={26} y={lane.y + 26}>
                    {lane.name}
                  </text>
                  {lane.criticality ? (
                    <g>
                      <rect className="topo2-lane-crit-bg" x={26} y={lane.y + 36} width={24} height={15} rx={4} />
                      <text className="topo2-lane-crit" x={38} y={lane.y + 47} textAnchor="middle">
                        {lane.criticality}
                      </text>
                    </g>
                  ) : null}
                  <text className="topo2-lane-meta" x={lane.criticality ? 58 : 26} y={lane.y + (lane.criticality ? 47 : 46)}>
                    {lane.hostCount} 台主机
                    {lane.anomalyCount > 0 ? ` · ${lane.anomalyCount} 台异常` : ''}
                  </text>
                  <text className="topo2-lane-meta is-strong" x={26} y={lane.y + 68}>
                    连接 {Math.round(lane.connections / 1000).toFixed(1)}k
                    {lane.failures > 0 ? ` · 失败 ${lane.failures}` : ''}
                  </text>
                </g>
              ))}
              {layout.cells.map((cell) => (
                <rect
                  key={`${cell.laneId}-${cell.tier}`}
                  className="topo2-cell"
                  x={cell.x}
                  y={cell.y}
                  width={cell.w}
                  height={cell.h}
                  rx={10}
                />
              ))}
            </>
          ) : (
            <>
              <rect className="topo2-header-bg" x={0} y={0} width={layout.width} height={layout.headerHeight} />
              {layout.columns.map((column) => (
                <g key={column.id} className="topo2-column-head">
                  <g transform={`translate(${column.x + 14} 14)`}>
                    <TierIcon tier={column.key} size={16} color={column.accent} strokeWidth={1.7} />
                  </g>
                  <text className="topo2-column-title" x={column.x + 38} y={26}>
                    {column.title}
                  </text>
                  <text className="topo2-column-en" x={column.x + 38} y={40}>
                    {column.en}
                  </text>
                  <text className="topo2-column-hint" x={column.x + 14} y={55}>
                    {column.hint}
                  </text>
                  <rect className="topo2-column-count-bg" x={column.x + column.w - 38} y={14} width={26} height={16} rx={5} />
                  <text className="topo2-column-count" x={column.x + column.w - 25} y={25.5} textAnchor="middle">
                    {column.count}
                  </text>
                  <rect className="topo2-system-col-bg" x={column.x} y={layout.headerHeight + 4} width={column.w} height={column.h} rx={12} />
                </g>
              ))}
              <line className="topo2-header-line" x1={0} y1={layout.headerHeight} x2={layout.width} y2={layout.headerHeight} />
              {layout.groups.map((group) => (
                <g key={`${group.systemId}-${group.x}`} className="topo2-group">
                  <rect className="topo2-group-bg" x={group.x} y={group.y} width={group.w} height={group.h} rx={12} fill={group.color} />
                  <circle cx={group.labelX + 4} cy={group.labelY - 4} r={3} fill={group.color} />
                  <text className="topo2-group-label" x={group.labelX + 12} y={group.labelY} fill={group.color}>
                    {group.name}
                    <tspan className="topo2-group-count"> · {group.count} 个节点</tspan>
                  </text>
                </g>
              ))}
            </>
          )}

          {sortedEdges.map((edge) => (
            <EdgePath
              key={edge.edge.id}
              edge={edge}
              active={activeEdgeIds.has(edge.edge.id)}
              dimmed={isEdgeDimmed(edge)}
              animated={edge.rank < animatedLimit}
              gradientId={edge.crossSystem && !edge.external && !edge.anomalous ? gradientIdOf(edge.edge.id) : null}
              markerId={markerIdOf(edge)}
              onHover={handleHoverEdge}
            />
          ))}

          {sortedNodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={selectedId === node.id}
              hovered={hoveredNodeId === node.id}
              highlighted={Boolean(emphasis?.nodes.has(node.id)) || (searching && matchedNodeIds.has(node.id))}
              dimmed={isNodeDimmed(node.id)}
              searching={searching}
              matched={matchedNodeIds.has(node.id)}
              onHover={handleHoverNode}
              onSelect={handleNodeSelect}
              onFocus={handleNodeFocus}
            />
          ))}

          {layout.labels.map((label) => (
            <g
              key={`static-${label.edgeId}`}
              className="topo2-edge-label is-static"
              transform={`translate(${(label.x - label.w / 2).toFixed(1)} ${(label.y - label.h / 2).toFixed(1)})`}
            >
              <rect width={label.w} height={label.h} rx={5} />
              <text x={6} y={label.h / 2 + 4}>
                {label.text}
              </text>
            </g>
          ))}

          {activeLabels.map((label) => (
            <g
              key={`active-${label.edge.edge.id}`}
              className={`topo2-edge-label${label.edge.anomalous ? ' is-anomalous' : ''}`}
              transform={`translate(${label.edge.mx.toFixed(1)} ${(label.edge.my + label.offset / Math.max(0.3, zoomK)).toFixed(1)}) scale(${(1 / Math.max(0.3, zoomK)).toFixed(4)})`}
            >
              <rect x={-label.w / 2} y={-label.h / 2} width={label.w} height={label.h} rx={5} />
              <text x={-label.w / 2 + 7} y={4}>
                {label.edge.fullLabel}
              </text>
            </g>
          ))}
        </g>
      </svg>

      <div className="topo2-zoom">
        <button type="button" className="topo2-zoom-btn" aria-label="缩小" onClick={() => {
          const currentSize = sizeRef.current;
          zoomAt(transformRef.current.k / 1.3, currentSize.w / 2, currentSize.h / 2);
        }}>
          <MiniIcon name="minus" size={14} />
        </button>
        <span className="topo2-zoom-value" ref={zoomLabelRef}>
          100%
        </span>
        <button type="button" className="topo2-zoom-btn" aria-label="放大" onClick={() => {
          const currentSize = sizeRef.current;
          zoomAt(transformRef.current.k * 1.3, currentSize.w / 2, currentSize.h / 2);
        }}>
          <MiniIcon name="plus" size={14} />
        </button>
        <span className="topo2-zoom-sep" />
        <button type="button" className="topo2-zoom-btn is-wide" onClick={fitView} title="适应画布（完整显示全图）">
          <MiniIcon name="fit" size={13} /> 适应
        </button>
        <button
          type="button"
          className={`topo2-zoom-btn is-wide${minimapOpen ? ' is-on' : ''}`}
          onClick={() => setMinimapOpen((current) => !current)}
          aria-pressed={minimapOpen}
          title="显示/隐藏全图缩略图"
        >
          <MiniIcon name="layers" size={13} /> 全图
        </button>
        <button type="button" className="topo2-zoom-btn is-wide" onClick={resetZoom} title="重置为 100%">
          1:1
        </button>
      </div>

      {minimapOpen ? (
      <div className="topo2-minimap">
        <button type="button" className="topo2-mini-close" aria-label="收起全图缩略图" onClick={() => setMinimapOpen(false)}>
          <MiniIcon name="close" size={11} />
        </button>
        <svg
          ref={miniSvgRef}
          width={miniWidth}
          height={miniHeight}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onMiniPointerDown}
          role="img"
          aria-label="拓扑缩略图"
        >
          <rect className="topo2-mini-bg" width={layout.width} height={layout.height} rx={8} />
          {view.mode === 'host'
            ? layout.lanes.map((lane) => (
                <rect key={lane.id} x={0} y={lane.y} width={layout.width} height={lane.h} fill={lane.color} opacity="0.09" />
              ))
            : layout.columns.map((column) => (
                <rect key={column.id} x={column.x} y={layout.headerHeight} width={column.w} height={column.h} fill={column.accent} opacity="0.08" />
              ))}
          {layout.nodes.map((node) => (
            <rect
              key={node.id}
              x={node.x}
              y={node.y}
              width={node.w}
              height={node.h}
              rx={6}
              fill={node.systemColor}
              opacity="0.7"
            />
          ))}
          <rect ref={miniViewportRef} className="topo2-mini-view" x={0} y={0} width={10} height={10} rx={3} />
        </svg>
        <span className="topo2-mini-caption">
          <MiniIcon name="layers" size={11} /> 全图 {Math.round(layout.width)} × {Math.round(layout.height)}
        </span>
      </div>
      ) : null}


    </div>
  );
}
