import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { KindIcon, MiniIcon, TierIcon } from './icons.js';

const MIN_K = 0.32;
const MAX_K = 2.4;

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
  return `topo-g-${edgeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function markerIdOf(edge: RoutedEdge): string {
  if (edge.anomalous) return 'topo-arrow-danger';
  if (edge.external) return 'topo-arrow-external';
  const index = SYSTEM_COLORS.indexOf(edge.colorB);
  return index >= 0 ? `topo-arrow-s${index}` : 'topo-arrow-external';
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
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, k: 0.86 });
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  const viewMode = view.mode;
  const miniWidth = 180;
  const miniHeight = useMemo(
    () => clamp((miniWidth * layout.height) / Math.max(1, layout.width), 74, 132),
    [layout.height, layout.width],
  );

  layoutRef.current = layout;
  sizeRef.current = size;

  const applyView = useCallback((): void => {
    const transform = transformRef.current;
    gRef.current?.setAttribute(
      'transform',
      `translate(${transform.x.toFixed(2)} ${transform.y.toFixed(2)}) scale(${transform.k.toFixed(4)})`,
    );
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(transform.k * 100)}%`;
    const viewport = miniViewportRef.current;
    const current = layoutRef.current;
    const currentSize = sizeRef.current;
    if (viewport && current && miniSvgRef.current) {
      const scale = miniWidth / Math.max(1, current.width);
      const visibleX = -transform.x / transform.k;
      const visibleY = -transform.y / transform.k;
      const visibleW = currentSize.w / transform.k;
      const visibleH = currentSize.h / transform.k;
      viewport.setAttribute('x', (visibleX * scale).toFixed(2));
      viewport.setAttribute('y', (visibleY * scale).toFixed(2));
      viewport.setAttribute('width', (visibleW * scale).toFixed(2));
      viewport.setAttribute('height', (visibleH * scale).toFixed(2));
    }
  }, [miniWidth]);

  const fitView = useCallback((): void => {
    const current = layoutRef.current;
    const currentSize = sizeRef.current;
    if (!current || currentSize.w === 0 || currentSize.h === 0) return;
    const pad = 30;
    const minK = viewMode === 'system' ? 0.62 : 0.68;
    const maxK = viewMode === 'system' ? 1.12 : 1.02;
    const k = clamp(
      Math.min((currentSize.w - pad * 2) / current.width, (currentSize.h - pad * 2) / current.height),
      minK,
      maxK,
    );
    transformRef.current = {
      k,
      x: (currentSize.w - current.width * k) / 2,
      y: (currentSize.h - current.height * k) / 2,
    };
    applyView();
  }, [applyView, viewMode]);

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
        Math.min(currentSize.w / (maxX - minX + 300), currentSize.h / (maxY - minY + 240), 1.25),
        0.62,
        1.25,
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
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, layout.width, layout.height]);

  useEffect(() => {
    applyView();
  }, [applyView, layout, miniHeight]);

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
    event.currentTarget.setPointerCapture(event.pointerId);
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
    transformRef.current = {
      ...transformRef.current,
      x: drag.originX + dx,
      y: drag.originY + dy,
    };
    applyView();
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleBackgroundClick = (): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelect(null);
    onFocus(null);
  };

  const handleBackgroundDoubleClick = (): void => {
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

  // ---- 高亮 / 淡化 -------------------------------------------------------
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
      if (viewMode === 'system' ? node.node.appSystemId === drillSystemId : node.systemId === drillSystemId) {
        nodes.add(node.id);
      }
    }
    return { nodes, edges: new Set(), hard: true, label: '业务系统聚焦' };
  }, [drillSystemId, layout.nodes, viewMode]);

  const emphasis = useMemo<Emphasis | null>(() => {
    if (hoveredEdgeId) {
      const edge = layout.edgeById.get(hoveredEdgeId);
      if (edge) {
        return {
          nodes: new Set([edge.sourceId, edge.targetId]),
          edges: new Set([edge.edge.id]),
          hard: false,
          label: edge.fullLabel,
        };
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
      const neighbor = neighborIds(layout, nodeId);
      for (const id of neighbor.nodes) active.add(id);
    }
    const inactive = layout.nodes.filter((node) => !active.has(node.id));
    const lit = layout.nodes.filter((node) => active.has(node.id));
    return [...inactive, ...lit];
  }, [focusId, hoveredNodeId, layout, selectedId]);

  // 静态端口标签
  const staticLabels = layout.labels;

  // hover / 聚焦时的完整关系标签：源服务 → 目标服务:端口
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
    if (ids.size === 0 && analysisNodeIds) {
      for (const edge of layout.edges) {
        if (analysisNodeIds.includes(edge.sourceId) || analysisNodeIds.includes(edge.targetId)) {
          ids.add(edge.edge.id);
          if (ids.size >= 6) break;
        }
      }
    }
    const staticIds = new Set(layout.labels.map((label) => label.edgeId));
    const chosen = [...ids]
      .filter((id) => !(view.mode === 'system' && staticIds.has(id)))
      .map((id) => layout.edgeById.get(id))
      .filter((edge) => edge !== undefined)
      .slice(0, 8);
    const occupied = layout.nodes.map((node) => ({
      x: node.x - 4,
      y: node.y - 4,
      w: node.w + 8,
      h: node.h + 8,
    }));
    const placed: { edge: RoutedEdge; x: number; y: number; w: number; h: number; text: string }[] = [];
    const overlaps = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number },
    ): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const edge of chosen) {
      const text = edge.fullLabel;
      const w = measureText(text, 11.5) + 16;
      const h = 19;
      const offsets = [0, -24, 24, -48, 48];
      let found: { x: number; y: number } | null = null;
      for (const offset of offsets) {
        const rect = { x: edge.mx - w / 2, y: edge.my + offset - h / 2, w, h };
        if (occupied.some((node) => overlaps(rect, node))) continue;
        if (placed.some((label) => overlaps(rect, { x: label.x - label.w / 2, y: label.y - label.h / 2, w: label.w, h: label.h }))) continue;
        found = { x: edge.mx, y: edge.my + offset };
        break;
      }
      if (!found) continue;
      placed.push({ edge, x: found.x, y: found.y, w, h, text });
    }
    return placed;
  }, [analysisEdgeIds, analysisNodeIds, focusId, hoveredEdgeId, hoveredNodeId, layout, selectedId]);

  const gradientEdges = useMemo(
    () => layout.edges.filter((edge) => edge.crossSystem && !edge.external && !edge.anomalous),
    [layout.edges],
  );

  const animatedLimit = layout.edges.length > 80 ? 30 : 26;

  return (
    <div className={`topo-canvas${viewMode === 'system' ? ' is-system-view' : ''}`} ref={wrapRef}>
      <svg
        className="topo-canvas-svg"
        width="100%"
        height="100%"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleBackgroundClick}
        onDoubleClick={handleBackgroundDoubleClick}
        role="application"
        aria-label="业务访问拓扑画布"
      >
        <defs>
          <pattern id="topo-stars" width="240" height="220" patternUnits="userSpaceOnUse">
            <circle cx="18" cy="24" r="1" fill="#9fd0ff" opacity="0.32" />
            <circle cx="92" cy="68" r="0.8" fill="#bcd9ff" opacity="0.24" />
            <circle cx="168" cy="32" r="1.1" fill="#8fb6ff" opacity="0.3" />
            <circle cx="212" cy="120" r="0.7" fill="#d7e9ff" opacity="0.22" />
            <circle cx="54" cy="156" r="0.9" fill="#9fd0ff" opacity="0.24" />
            <circle cx="132" cy="190" r="1.2" fill="#7fa8ff" opacity="0.2" />
            <circle cx="196" cy="196" r="0.8" fill="#cfe6ff" opacity="0.26" />
          </pattern>
          <linearGradient id="topo-vignette" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0b1a30" />
            <stop offset="0.45" stopColor="#060d18" />
            <stop offset="1" stopColor="#04070d" />
          </linearGradient>
          <radialGradient id="topo-halo" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#2b6dff" stopOpacity="0.3" />
            <stop offset="0.6" stopColor="#1b4fd8" stopOpacity="0.06" />
            <stop offset="1" stopColor="#0a0f18" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="topo-halo-warm" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#12b5a0" stopOpacity="0.2" />
            <stop offset="1" stopColor="#0a0f18" stopOpacity="0" />
          </radialGradient>
          {SYSTEM_COLORS.map((color, index) => (
            <marker
              key={`marker-${color}`}
              id={`topo-arrow-s${index}`}
              markerWidth="9"
              markerHeight="9"
              refX="7.6"
              refY="4.5"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0.6 1 L8.4 4.5 L0.6 8 Z" fill={color} />
            </marker>
          ))}
          <marker id="topo-arrow-danger" markerWidth="10" markerHeight="10" refX="8.4" refY="5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0.6 1 L9.2 5 L0.6 9 Z" fill="#ff6b6b" />
          </marker>
          <marker id="topo-arrow-external" markerWidth="9" markerHeight="9" refX="7.6" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0.6 1 L8.4 4.5 L0.6 8 Z" fill="#9fb3d1" />
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
              <stop offset="0" stopColor={edge.colorA} stopOpacity="0.92" />
              <stop offset="1" stopColor={edge.colorB} stopOpacity="0.98" />
            </linearGradient>
          ))}
        </defs>

        <rect className="topo-canvas-bg" width="100%" height="100%" fill="url(#topo-vignette)" />
        <rect width="100%" height="100%" fill="url(#topo-stars)" opacity="0.9" />
        <ellipse className="topo-canvas-halo" cx="30%" cy="18%" rx="46%" ry="52%" fill="url(#topo-halo)" />
        <ellipse className="topo-canvas-halo" cx="82%" cy="84%" rx="38%" ry="42%" fill="url(#topo-halo-warm)" />

        <g ref={gRef}>
          {layout.tiers.map((tier) => (
            <g key={`${tier.key}-${tier.x}`} className="topo-tier">
              <rect className="topo-tier-band" x={tier.x} y={6} width={tier.w} height={tier.h} rx={16} fill={tier.accent} stroke={tier.accent} />
              <line className="topo-tier-rule" x1={tier.x + 16} y1={58} x2={tier.x + tier.w - 16} y2={58} stroke={tier.accent} />
              <g transform={`translate(${tier.x + 15} 18)`}>
                <TierIcon tier={tier.icon ?? tier.key} size={17} color={tier.accent} strokeWidth={1.7} />
              </g>
              <text className="topo-tier-title" x={tier.x + 38} y={30} fill={tier.accent}>
                {tier.title}
              </text>
              <text className="topo-tier-en" x={tier.x + 38} y={45}>
                {tier.en}
              </text>
              <text className="topo-tier-count" x={tier.x + tier.w - 16} y={31} textAnchor="end">
                {String(tier.count).padStart(2, '0')}
              </text>
              <text className="topo-tier-sub" x={tier.x + tier.w - 16} y={46} textAnchor="end">
                {tier.subLabel ?? `${tier.systems} 系统`}
              </text>
            </g>
          ))}

          {layout.groups.map((group) => (
            <g key={`${group.tier}-${group.systemId}-${group.x}`} className="topo-group">
              <rect className="topo-group-bg" x={group.x} y={group.y} width={group.w} height={group.h} rx={13} fill={group.color} stroke={group.color} />
              <circle cx={group.labelX + 4} cy={group.labelY - 4} r={3} fill={group.color} />
              <text className="topo-group-label" x={group.labelX + 12} y={group.labelY} fill={group.color}>
                {group.name}
                <tspan className="topo-group-count"> · {group.count} 节点</tspan>
              </text>
            </g>
          ))}

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

          {staticLabels.map((label) => (
            <g
              key={`static-${label.edgeId}`}
              className={view.mode === 'system' ? 'topo-edge-label is-static' : 'topo-port-label'}
              transform={`translate(${(label.x - label.w / 2).toFixed(1)} ${(label.y - label.h / 2).toFixed(1)})`}
            >
              <rect width={label.w} height={label.h} rx={5} />
              <text x={5} y={label.h / 2 + 4}>
                {label.text}
              </text>
            </g>
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

          {activeLabels.map((label) => (
            <g
              key={`active-${label.edge.edge.id}`}
              className="topo-edge-label"
              transform={`translate(${(label.x - label.w / 2).toFixed(1)} ${(label.y - label.h / 2).toFixed(1)})`}
            >
              <rect width={label.w} height={label.h} rx={5} stroke={label.edge.anomalous ? '#ff6b6b' : label.edge.colorB} />
              <text x={6} y={label.h / 2 + 4}>
                {label.text}
              </text>
            </g>
          ))}
        </g>
      </svg>

      <div className="topo-zoom">
        <button type="button" className="topo-zoom-btn" aria-label="缩小" onClick={() => {
          const currentSize = sizeRef.current;
          zoomAt(transformRef.current.k / 1.22, currentSize.w / 2, currentSize.h / 2);
        }}>
          <MiniIcon name="minus" size={14} />
        </button>
        <span className="topo-zoom-value" ref={zoomLabelRef}>
          100%
        </span>
        <button type="button" className="topo-zoom-btn" aria-label="放大" onClick={() => {
          const currentSize = sizeRef.current;
          zoomAt(transformRef.current.k * 1.22, currentSize.w / 2, currentSize.h / 2);
        }}>
          <MiniIcon name="plus" size={14} />
        </button>
        <button type="button" className="topo-zoom-btn is-wide" onClick={fitView} title="适应画布">
          <MiniIcon name="fit" size={14} />
          适应
        </button>
      </div>

      <div className="topo-minimap">
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
          <rect className="topo-mini-bg" width={layout.width} height={layout.height} rx={10} />
          {layout.tiers.map((tier) => (
            <rect key={`${tier.key}-${tier.x}`} x={tier.x} y={6} width={tier.w} height={tier.h} rx={12} fill={tier.accent} opacity="0.08" />
          ))}
          {layout.edges.map((edge) => (
            <line
              key={edge.edge.id}
              x1={edge.ax}
              y1={edge.ay}
              x2={edge.bx}
              y2={edge.by}
              stroke={edge.anomalous ? '#ff6b6b' : edge.colorA}
              strokeWidth={3}
              strokeOpacity={0.4}
            />
          ))}
          {layout.nodes.map((node) => (
            <rect
              key={node.id}
              x={node.x}
              y={node.y}
              width={node.w}
              height={node.h}
              rx={8}
              fill={node.systemColor}
              opacity={0.82}
            />
          ))}
          <rect ref={miniViewportRef} className="topo-mini-view" x={0} y={0} width={10} height={10} rx={4} />
        </svg>
        <span className="topo-mini-caption">
          <MiniIcon name="layers" size={11} /> 全图 {Math.round(layout.width)} × {Math.round(layout.height)}
        </span>
      </div>

      <div className="topo-canvas-tip">
        <KindIcon kind="service" size={12} color="#7fa4d6" />
        拖拽平移 · 滚轮缩放 · 双击节点聚焦上下游
      </div>
    </div>
  );
}
