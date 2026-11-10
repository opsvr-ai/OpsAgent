/**
 * 访问拓扑布局：把 TopologyGraph 投影成一份可绘制的分层画布。
 *
 * - 主机视图：ingress → app → middleware → data → external 五列，节点按业务系统聚簇；
 * - 业务系统视图：把同一应用系统的主机折叠成一个系统节点，边按系统对聚合；
 * - 布局是纯函数，画布只负责绘制和交互，避免每帧重算。
 */
import type {
  TopologyEdge,
  TopologyGraph,
  TopologyNode,
  TopologyNodeKind,
  TopologyServicePort,
  TopologySystemGroup,
  TopologyTier,
} from '@opsagent/contracts';

export type TopoViewMode = 'host' | 'system';

export const SYSTEM_COLORS: readonly string[] = [
  '#5b8cff',
  '#a78bfa',
  '#2dd4bf',
  '#fbbf24',
  '#fb7185',
  '#34d399',
];

export const EXTERNAL_COLOR = '#8fa3bf';
export const UNASSIGNED_COLOR = '#7c8da6';

export const TIER_ORDER: readonly TopologyTier[] = [
  'ingress',
  'app',
  'middleware',
  'data',
  'external',
  'infra',
];

export interface TierMeta {
  readonly title: string;
  readonly en: string;
  readonly accent: string;
}

export const TIER_META: Readonly<Record<TopologyTier, TierMeta>> = {
  ingress: { title: '接入层', en: 'INGRESS', accent: '#5b8cff' },
  app: { title: '应用层', en: 'APP', accent: '#22d3ee' },
  middleware: { title: '中间件层', en: 'MIDDLEWARE', accent: '#a78bfa' },
  data: { title: '数据层', en: 'DATA', accent: '#34d399' },
  external: { title: '外部依赖', en: 'EXTERNAL', accent: '#f59e0b' },
  infra: { title: '基础设施', en: 'INFRA', accent: '#94a3b8' },
};

export interface ViewNode {
  readonly node: TopologyNode;
  readonly aggregated: boolean;
  readonly hostCount: number;
  readonly internalConnections: number;
}

export interface ViewGraph {
  readonly graph: TopologyGraph;
  readonly mode: TopoViewMode;
  readonly nodes: readonly ViewNode[];
  readonly edges: readonly TopologyEdge[];
  readonly systems: readonly TopologySystemGroup[];
  readonly systemIdByHost: ReadonlyMap<string, string>;
}

export interface PositionedNode {
  readonly node: TopologyNode;
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly tier: TopologyTier;
  readonly systemId: string | null;
  readonly systemColor: string;
  readonly systemIndex: number;
  readonly aggregated: boolean;
  readonly hostCount: number;
  readonly internalConnections: number;
  readonly incoming: number;
  readonly outgoing: number;
  readonly failed: number;
  readonly connections: number;
}

export interface RoutedEdge {
  readonly edge: TopologyEdge;
  readonly d: string;
  readonly mx: number;
  readonly my: number;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceService: string;
  readonly targetService: string;
  readonly fullLabel: string;
  readonly compactLabel: string;
  readonly systemA: string | null;
  readonly systemB: string | null;
  readonly colorA: string;
  readonly colorB: string;
  readonly ratio: number;
  readonly failureRate: number;
  readonly anomalous: boolean;
  readonly crossSystem: boolean;
  readonly external: boolean;
  readonly systemEdge: boolean;
  readonly rank: number;
}

export interface RoutedLabel {
  readonly edgeId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text: string;
}

export interface TierBand {
  readonly key: TopologyTier;
  readonly title: string;
  readonly en: string;
  readonly accent: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly count: number;
  readonly systems: number;
  readonly icon?: TopologyTier;
  readonly subLabel?: string;
}

export interface GroupHull {
  readonly systemId: string;
  readonly name: string;
  readonly color: string;
  readonly tier: TopologyTier;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly count: number;
  readonly labelX: number;
  readonly labelY: number;
}

export interface TopoLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PositionedNode[];
  readonly nodeById: ReadonlyMap<string, PositionedNode>;
  readonly edges: readonly RoutedEdge[];
  readonly edgeById: ReadonlyMap<string, RoutedEdge>;
  readonly labels: readonly RoutedLabel[];
  readonly tiers: readonly TierBand[];
  readonly groups: readonly GroupHull[];
  readonly systemLegend: readonly {
    id: string;
    name: string;
    color: string;
    nodeCount: number;
    connections: number;
  }[];
  readonly maxEdgeCount: number;
  readonly totalConnections: number;
  readonly failedConnections: number;
  readonly anomalies: number;
}

// ---------------------------------------------------------------------------
// 视图投影
// ---------------------------------------------------------------------------

function uniqueServices(nodes: readonly TopologyNode[]): readonly TopologyServicePort[] {
  const map = new Map<string, TopologyServicePort & { weight: number }>();
  for (const node of nodes) {
    for (const service of node.services) {
      const key = `${service.name}:${service.port}`;
      const current = map.get(key);
      if (current) map.set(key, { ...current, weight: current.weight + 1 });
      else map.set(key, { ...service, weight: 1 });
    }
  }
  return [...map.values()]
    .sort((a, b) => b.weight - a.weight || a.port - b.port)
    .slice(0, 4)
    .map(({ weight: _weight, ...service }) => service);
}

function dominantTier(nodes: readonly TopologyNode[]): TopologyTier {
  const counts = new Map<TopologyTier, number>();
  for (const node of nodes) counts.set(node.tier, (counts.get(node.tier) ?? 0) + 1);
  let best: TopologyTier = 'app';
  let bestCount = -1;
  for (const tier of TIER_ORDER) {
    const count = counts.get(tier) ?? 0;
    if (count > bestCount) {
      best = tier;
      bestCount = count;
    }
  }
  return best === 'ingress' ? 'app' : best;
}

function dominantKind(nodes: readonly TopologyNode[]): TopologyNodeKind {
  const counts = new Map<TopologyNodeKind, number>();
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  let best: TopologyNodeKind = 'service';
  let bestCount = -1;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

function aggregateNode(system: TopologySystemGroup, hosts: readonly TopologyNode[]): ViewNode {
  const nodeId = `sys:${system.id}`;
  const status: TopologyNode['status'] = hosts.some((host) => host.status === 'online')
    ? 'online'
    : hosts.every((host) => host.status === 'offline')
      ? 'offline'
      : 'unknown';
  const metrics = hosts.reduce(
    (sum, host) => ({
      active: sum.active + host.metrics.active,
      opened: sum.opened + host.metrics.opened,
      closed: sum.closed + host.metrics.closed,
      failed: sum.failed + host.metrics.failed,
      inbound: sum.inbound + host.metrics.inbound,
      outbound: sum.outbound + host.metrics.outbound,
    }),
    { active: 0, opened: 0, closed: 0, failed: 0, inbound: 0, outbound: 0 },
  );
  const anomalies = [...new Set(hosts.flatMap((host) => host.anomalies ?? []))].slice(0, 3);
  const node: TopologyNode = {
    id: nodeId,
    label: system.name,
    kind: dominantKind(hosts),
    tier: dominantTier(hosts),
    status,
    services: uniqueServices(hosts),
    metrics,
    appSystemId: system.id,
    appSystemName: system.name,
    ...(anomalies.length > 0 ? { anomalies } : {}),
    inferred: false,
    note: `${hosts.length} 台主机折叠`,
  };
  return { node, aggregated: true, hostCount: hosts.length, internalConnections: 0 };
}

export function buildViewGraph(graph: TopologyGraph, mode: TopoViewMode): ViewGraph {
  const systemIdByHost = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.appSystemId) systemIdByHost.set(node.id, node.appSystemId);
  }
  if (mode === 'host') {
    return {
      graph,
      mode,
      nodes: graph.nodes.map((node) => ({
        node,
        aggregated: false,
        hostCount: 1,
        internalConnections: 0,
      })),
      edges: graph.edges,
      systems: graph.systems,
      systemIdByHost,
    };
  }

  const systems = graph.systems.filter((system) => {
    const explicit = new Set(system.nodeIds);
    return graph.nodes.some((node) => explicit.has(node.id) || node.appSystemId === system.id);
  });
  const known = new Set(systems.map((system) => system.id));
  const systemNodes: ViewNode[] = [];
  const hostToView = new Map<string, string>();
  const internal = new Map<string, number>();
  for (const system of systems) {
    const hosts = graph.nodes.filter(
      (node) => node.appSystemId === system.id || system.nodeIds.includes(node.id),
    );
    for (const host of hosts) hostToView.set(host.id, `sys:${system.id}`);
    const viewNode = aggregateNode(system, hosts);
    systemNodes.push(viewNode);
  }
  for (const node of graph.nodes) {
    if (node.appSystemId && known.has(node.appSystemId)) continue;
    if (node.appSystemId && systemIdByHost.has(node.id)) continue;
    hostToView.set(node.id, node.id);
    systemNodes.push({ node, aggregated: false, hostCount: 1, internalConnections: 0 });
  }

  const edgeMap = new Map<string, TopologyEdge & { weight: number }>();
  for (const edge of graph.edges) {
    const source = hostToView.get(edge.source);
    const target = hostToView.get(edge.target);
    if (!source || !target) continue;
    if (source === target) {
      internal.set(source, (internal.get(source) ?? 0) + edge.count);
      continue;
    }
    const key = `${source}->${target}`;
    const current = edgeMap.get(key);
    if (!current) {
      edgeMap.set(key, {
        id: `agg:${key}`,
        source,
        target,
        protocol: edge.protocol,
        port: edge.port,
        count: edge.count,
        opened: edge.opened,
        failed: edge.failed,
        confidence: edge.confidence,
        countBasis: edge.countBasis ?? 'observed',
        direction: 'out',
        ...(edge.external ? { external: true } : {}),
        weight: 1,
      });
    } else {
      edgeMap.set(key, {
        ...current,
        count: current.count + edge.count,
        opened: current.opened + edge.opened,
        failed: current.failed + edge.failed,
        confidence: Math.min(current.confidence, edge.confidence),
        ...(current.external || edge.external ? { external: true } : {}),
        weight: current.weight + 1,
      });
    }
  }
  const edges: TopologyEdge[] = [...edgeMap.values()].map(({ weight: _weight, ...edge }) => ({
    ...edge,
    label: `${edge.count.toLocaleString('zh-CN')} 次连接`,
  }));
  const nodes = systemNodes.map((item) =>
    item.aggregated
      ? { ...item, internalConnections: internal.get(item.node.id) ?? 0 }
      : item,
  );
  return {
    graph,
    mode,
    nodes,
    edges,
    systems: systems.map((system) => ({
      ...system,
      nodeIds: [`sys:${system.id}`],
    })),
    systemIdByHost,
  };
}

// ---------------------------------------------------------------------------
// 几何工具
// ---------------------------------------------------------------------------

const CJK = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

export function measureText(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) {
    if (CJK.test(char)) units += 1;
    else if (char === ' ') units += 0.34;
    else units += 0.58;
  }
  return units * fontSize;
}

export function truncateText(text: string, maxWidth: number, fontSize: number): string {
  if (measureText(text, fontSize) <= maxWidth) return text;
  let result = '';
  let width = 0;
  for (const char of text) {
    const units = CJK.test(char) ? 1 : char === ' ' ? 0.34 : 0.58;
    if (width + units * fontSize > maxWidth - fontSize * 0.9) break;
    result += char;
    width += units * fontSize;
  }
  return `${result}…`;
}

/** 按宽度把标题折成最多两行，优先在 - _ . 空格和驼峰边界断开。 */
export function wrapLines(
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines = 2,
): string[] {
  if (measureText(text, fontSize) <= maxWidth) return [text];
  const breaks = new Set<number>();
  for (let index = 1; index < text.length; index += 1) {
    const previous = text[index - 1] ?? '';
    const current = text[index] ?? '';
    if (previous === '-' || previous === '_' || previous === '.' || previous === ' ' || previous === '/') {
      breaks.add(index);
    }
    if (/[a-z]/.test(previous) && /[A-Z]/.test(current)) breaks.add(index);
  }
  const lines: string[] = [];
  let rest = text;
  while (rest.length > 0 && lines.length < maxLines) {
    if (measureText(rest, fontSize) <= maxWidth) {
      lines.push(rest);
      rest = '';
      break;
    }
    let cut = -1;
    let width = 0;
    for (let index = 0; index < rest.length; index += 1) {
      const char = rest[index] ?? '';
      const units = CJK.test(char) ? 1 : char === ' ' ? 0.34 : 0.58;
      if (width + (units * fontSize) > maxWidth) break;
      width += units * fontSize;
      if (breaks.has(index + 1)) cut = index + 1;
    }
    if (cut <= 0) {
      let fallback = 0;
      let fallbackWidth = 0;
      for (let index = 0; index < rest.length; index += 1) {
        const char = rest[index] ?? '';
        const units = CJK.test(char) ? 1 : char === ' ' ? 0.34 : 0.58;
        if (fallbackWidth + units * fontSize > maxWidth) break;
        fallbackWidth += units * fontSize;
        fallback = index + 1;
      }
      cut = Math.max(1, fallback);
    }
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0 && lines.length > 0) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = truncateText(`${lines[lastIndex] ?? ''}${rest}`, maxWidth, fontSize);
  }
  return lines;
}

export interface CardLayout {
  readonly w: number;
  readonly h: number;
  readonly titleLines: readonly string[];
  readonly titleFont: number;
  readonly titleX: number;
  readonly titleY: number;
  readonly titleLineHeight: number;
  readonly iconX: number;
  readonly iconY: number;
  readonly iconSize: number;
  readonly iconTile: number;
  readonly subText: string;
  readonly subX: number;
  readonly subY: number;
  readonly ipText: string;
  readonly ipY: number;
  readonly chipY: number;
  readonly chipFont: number;
  readonly metricsY: number;
  readonly metricsFont: number;
}

/**
 * 主机卡片尺寸由内容决定：标题最多两行、主机名/IP 完整显示。
 * 布局与绘制共用这一份几何，避免两边算得不一样。
 */
export function cardLayout(
  node: TopologyNode,
  aggregated: boolean,
  mode: TopoViewMode,
): CardLayout {
  if (aggregated) {
    const w = 208;
    const titleFont = 17;
    const titleX = 52;
    const titleMax = w - titleX - 20;
    const lines = wrapLines(node.label, titleMax, titleFont, 2);
    const h = lines.length > 1 ? 146 : 132;
    return {
      w,
      h,
      titleLines: lines,
      titleFont,
      titleX,
      titleY: 30,
      titleLineHeight: 19,
      iconX: 18,
      iconY: 18,
      iconSize: 20,
      iconTile: 32,
      subText: '',
      subX: 20,
      subY: 61,
      ipText: '',
      ipY: 0,
      chipY: lines.length > 1 ? 84 : 68,
      chipFont: 11,
      metricsY: h - 11,
      metricsFont: 11.5,
    };
  }
  const w = mode === 'system' ? 176 : 176;
  const titleX = 40;
  const titleMax = w - titleX - 18;
  // 主机名偏长时降一档字号，尽量让 gateway-order-01 / prod-mysql-pay-01 单行完整显示。
  const titleFont = measureText(node.label, 13.5) > titleMax ? 11.5 : 13.5;
  const titleLineHeight = titleFont >= 13 ? 15 : 13;
  const lines = wrapLines(node.label, titleMax, titleFont, 2);
  const host = node.hostname ?? '';
  const ip = node.ip ?? '';
  const subText = host && host !== node.label ? host : ip;
  const showIp = Boolean(ip) && ip !== subText && (node.inferred === true || node.kind === 'external');
  const titleHeight = lines.length * titleLineHeight;
  const subY = 10 + titleHeight + 10;
  const ipY = subY + 14;
  const chipY = (showIp ? ipY : subY) + 9;
  const h = chipY + 17 + 20;
  return {
    w,
    h,
    titleLines: lines,
    titleFont,
    titleX,
    titleY: 23,
    titleLineHeight,
    iconX: 13,
    iconY: 13,
    iconSize: 15,
    iconTile: 24,
    subText,
    subX: 10,
    subY,
    ipText: showIp ? ip : '',
    ipY,
    chipY,
    chipFont: 11,
    metricsY: h - 10,
    metricsFont: 11.5,
  };
}

function compactNumber(value: number): string {
  if (value >= 100_000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatConnections(value: number): string {
  return compactNumber(value);
}

/** 服务 chip 文案：避免出现 `port 443:443` 这类重复端口。 */
export function serviceLabel(service: TopologyServicePort): string {
  const name = service.name.trim();
  const port = String(service.port);
  if (!name || name === port) return `:${port}`;
  if (/^port\s*\d*$/i.test(name) || /^\d+$/.test(name)) return `:${port}`;
  if (name.endsWith(`:${port}`)) return name;
  return `${name}:${port}`;
}

/** 按主机名 / IP / 服务端口 / 业务系统 / 异常文字过滤节点，供画布与搜索定位共用。 */
export function matchNodeIds(layout: TopoLayout, search: string): ReadonlySet<string> {
  const query = search.trim().toLowerCase();
  const matches = new Set<string>();
  if (!query) return matches;
  for (const node of layout.nodes) {
    const haystack = [
      node.node.label,
      node.node.hostname ?? '',
      node.node.ip ?? '',
      node.node.appSystemName ?? '',
      ...node.node.services.map((service) => `${service.name}:${service.port}`),
      ...(node.node.anomalies ?? []),
    ]
      .join(' ')
      .toLowerCase();
    if (haystack.includes(query)) matches.add(node.id);
  }
  return matches;
}

function failureRateOf(edge: TopologyEdge): number {
  const base = Math.max(edge.opened, edge.count, 1);
  return edge.failed / base;
}

function isAnomalous(edge: TopologyEdge): boolean {
  return edge.failed > 0 && (failureRateOf(edge) >= 0.05 || edge.failed >= 20);
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

interface Geometry {
  readonly cardW: number;
  readonly cardH: number;
  readonly systemCardW: number;
  readonly systemCardH: number;
  readonly bandPad: number;
  readonly tierGap: number;
  readonly padX: number;
  readonly padTop: number;
  readonly padBottom: number;
  readonly headerH: number;
  readonly nodeGap: number;
  readonly groupGap: number;
  readonly columnGap: number;
  readonly maxColumnHeight: number;
}

const HOST_GEOMETRY: Geometry = {
  cardW: 176,
  cardH: 88,
  systemCardW: 236,
  systemCardH: 118,
  bandPad: 14,
  tierGap: 12,
  padX: 18,
  padTop: 18,
  padBottom: 26,
  headerH: 44,
  nodeGap: 12,
  groupGap: 28,
  columnGap: 20,
  maxColumnHeight: 780,
};

const SYSTEM_GEOMETRY: Geometry = {
  cardW: 176,
  cardH: 88,
  systemCardW: 236,
  systemCardH: 118,
  bandPad: 18,
  tierGap: 128,
  padX: 34,
  padTop: 22,
  padBottom: 30,
  headerH: 50,
  nodeGap: 18,
  groupGap: 34,
  columnGap: 32,
  maxColumnHeight: 1180,
};

interface Placement {
  readonly viewNode: ViewNode;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly systemId: string | null;
  readonly systemIndex: number;
  readonly column: number;
}

export function computeLayout(view: ViewGraph): TopoLayout {
  if (view.mode === 'system') return computeSystemLayout(view);
  const geometry = HOST_GEOMETRY;
  const systems = view.systems;
  const systemIndex = new Map(systems.map((system, index) => [system.id, index]));
  const systemNames = new Map(systems.map((system) => [system.id, system.name]));

  const tierNodes = new Map<TopologyTier, ViewNode[]>();
  for (const item of view.nodes) {
    const list = tierNodes.get(item.node.tier) ?? [];
    list.push(item);
    tierNodes.set(item.node.tier, list);
  }
  const tiers = TIER_ORDER.filter((tier) => (tierNodes.get(tier)?.length ?? 0) > 0);
  const activeTiers = tiers.length > 0 ? tiers : ['app' as TopologyTier];

  const cardSize = (item: ViewNode): { w: number; h: number } => {
    const geometryOfCard = cardLayout(item.node, item.aggregated, view.mode);
    return { w: geometryOfCard.w, h: geometryOfCard.h };
  };

  const edgesByPair = new Map<string, number>();
  for (const edge of view.edges) {
    const key = `${edge.source}->${edge.target}`;
    edgesByPair.set(key, (edgesByPair.get(key) ?? 0) + 1);
  }

  // 每层先按业务系统聚簇、再按状态排序，离线/未知沉底。
  const orderedByTier = new Map<TopologyTier, ViewNode[]>();
  for (const tier of activeTiers) {
    const list = [...(tierNodes.get(tier) ?? [])];
    list.sort((a, b) => {
      const sa = a.node.appSystemId ? (systemIndex.get(a.node.appSystemId) ?? 99) : 98;
      const sb = b.node.appSystemId ? (systemIndex.get(b.node.appSystemId) ?? 99) : 98;
      if (sa !== sb) return sa - sb;
      const weight = (item: ViewNode): number =>
        item.node.status === 'offline' ? 2 : item.node.status === 'unknown' ? 1 : 0;
      if (weight(a) !== weight(b)) return weight(a) - weight(b);
      return a.node.label.localeCompare(b.node.label, 'zh-CN');
    });
    orderedByTier.set(tier, list);
  }

  // 一列放不下时自动分栏，避免 120 节点的图长成一条。
  const columnsByTier = new Map<TopologyTier, ViewNode[][]>();
  for (const tier of activeTiers) {
    const list = orderedByTier.get(tier) ?? [];
    const columns: ViewNode[][] = [[]];
    let used = 0;
    let lastSystem: string | null | undefined;
    for (const item of list) {
      const size = cardSize(item);
      const systemId = item.node.appSystemId ?? null;
      const gap = used === 0 ? 0 : lastSystem === systemId ? geometry.nodeGap : geometry.groupGap;
      if (columns[columns.length - 1]!.length > 0 && used + gap + size.h > geometry.maxColumnHeight) {
        columns.push([]);
        used = 0;
        lastSystem = undefined;
      }
      const columnGap = used === 0 ? 0 : lastSystem === systemId ? geometry.nodeGap : geometry.groupGap;
      used += columnGap + size.h;
      columns[columns.length - 1]!.push(item);
      lastSystem = systemId;
    }
    columnsByTier.set(tier, columns);
  }

  const tierWidths = new Map<TopologyTier, number>();
  const tierColumnWidths = new Map<TopologyTier, number>();
  for (const tier of activeTiers) {
    const columns = columnsByTier.get(tier) ?? [];
    const widest = Math.max(
      ...columns.map((column) => Math.max(...column.map((item) => cardSize(item).w))),
      geometry.cardW,
    );
    const width = columns.length * widest + Math.max(0, columns.length - 1) * geometry.columnGap;
    tierWidths.set(tier, width);
    tierColumnWidths.set(tier, widest);
  }

  const bandX = new Map<TopologyTier, number>();
  let cursor = geometry.padX;
  for (const tier of activeTiers) {
    bandX.set(tier, cursor);
    cursor += (tierWidths.get(tier) ?? geometry.cardW) + geometry.bandPad * 2 + geometry.tierGap;
  }
  const contentRight = cursor - geometry.tierGap;
  const worldWidth = Math.max(560, contentRight + geometry.padX);

  const placements: Placement[] = [];
  let maxBottom = 0;
  for (const tier of activeTiers) {
    const columns = columnsByTier.get(tier) ?? [];
    const tierX = bandX.get(tier) ?? geometry.padX;
    const widest = tierColumnWidths.get(tier) ?? geometry.cardW;
    columns.forEach((column, columnIndex) => {
      const columnX = tierX + geometry.bandPad + columnIndex * (widest + geometry.columnGap);
      let y = geometry.padTop + geometry.headerH;
      let previousSystem: string | null | undefined;
      column.forEach((item, index) => {
        const size = cardSize(item);
        const systemId = item.node.appSystemId ?? null;
        const gap = index === 0 ? geometry.groupGap : previousSystem === systemId ? geometry.nodeGap : geometry.groupGap;
        y += gap;
        const x = columnX + (widest - size.w) / 2;
        placements.push({
          viewNode: item,
          x,
          y,
          w: size.w,
          h: size.h,
          systemId,
          systemIndex: systemId ? (systemIndex.get(systemId) ?? 98) : 98,
          column: columnIndex,
        });
        y += size.h;
        previousSystem = systemId;
      });
      maxBottom = Math.max(maxBottom, y);
    });
  }

  const worldHeight = Math.max(440, maxBottom + geometry.padBottom);

  const nodeById = new Map<string, PositionedNode>();
  const edgeCounts = new Map<string, { incoming: number; outgoing: number; failed: number; connections: number }>();
  for (const edge of view.edges) {
    const source = edgeCounts.get(edge.source) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
    source.outgoing += edge.count;
    source.connections += edge.count;
    source.failed += edge.failed;
    edgeCounts.set(edge.source, source);
    const target = edgeCounts.get(edge.target) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
    target.incoming += edge.count;
    target.connections += edge.count;
    target.failed += edge.failed;
    edgeCounts.set(edge.target, target);
  }

  for (const placement of placements) {
    const item = placement.viewNode;
    const stats = edgeCounts.get(item.node.id) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
    const color =
      placement.systemId !== null
        ? (SYSTEM_COLORS[placement.systemIndex % SYSTEM_COLORS.length] ?? SYSTEM_COLORS[0]!)
        : EXTERNAL_COLOR;
    nodeById.set(item.node.id, {
      node: item.node,
      id: item.node.id,
      x: placement.x,
      y: placement.y,
      w: placement.w,
      h: placement.h,
      tier: item.node.tier,
      systemId: placement.systemId,
      systemColor: color,
      systemIndex: placement.systemIndex,
      aggregated: item.aggregated,
      hostCount: item.hostCount,
      internalConnections: item.internalConnections,
      incoming: stats.incoming,
      outgoing: stats.outgoing,
      failed: stats.failed,
      connections: stats.connections,
    });
  }

  const sortedEdges = [...view.edges].sort((a, b) => b.count - a.count);
  const rankById = new Map(sortedEdges.map((edge, index) => [edge.id, index]));
  const maxEdgeCount = sortedEdges[0]?.count ?? 1;
  const routed: RoutedEdge[] = [];
  for (const edge of view.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const pairKey = `${edge.source}->${edge.target}`;
    const samePair = edgesByPair.get(pairKey) ?? 1;
    const pairIndex = routed.filter((item) => item.edge.source === edge.source && item.edge.target === edge.target).length;
    const stagger = (pairIndex - (samePair - 1) / 2) * 12;
    const forward = target.x > source.x + source.w * 0.55;
    const backwards = target.x + target.w < source.x + source.w * 0.45;
    let d: string;
    let mx: number;
    let my: number;
    let ax: number;
    let ay: number;
    let bx: number;
    let by: number;
    if (forward) {
      const sx = source.x + source.w;
      const sy = source.y + source.h / 2 + stagger * 0.4;
      const tx = target.x - 2;
      const ty = target.y + target.h / 2 + stagger * 0.4;
      const dx = Math.max(36, (tx - sx) * 0.46);
      const c1x = sx + dx;
      const c1y = sy + stagger;
      const c2x = tx - dx;
      const c2y = ty + stagger * 0.5;
      d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      mx = (sx + 3 * c1x + 3 * c2x + tx) / 8;
      my = (sy + 3 * c1y + 3 * c2y + ty) / 8;
      ax = sx;
      ay = sy;
      bx = tx;
      by = ty;
    } else if (backwards) {
      const sx = source.x;
      const sy = source.y + source.h / 2;
      const tx = target.x + target.w + 2;
      const ty = target.y + target.h / 2;
      const bow = 74 + Math.abs(pairIndex) * 10;
      const c1x = sx - 54 - pairIndex * 8;
      const c1y = sy + bow;
      const c2x = tx + 54 + pairIndex * 8;
      const c2y = ty + bow;
      d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      mx = (sx + 3 * c1x + 3 * c2x + tx) / 8;
      my = (sy + 3 * c1y + 3 * c2y + ty) / 8;
      ax = sx;
      ay = sy;
      bx = tx;
      by = ty;
    } else {
      const sx = source.x + source.w;
      const sy = source.y + source.h / 2 + stagger;
      const tx = target.x + target.w;
      const ty = target.y + target.h / 2 + stagger;
      const bow = 68 + Math.abs(pairIndex) * 9;
      const c1x = sx + bow;
      const c2x = tx + bow;
      d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${sy.toFixed(1)}, ${c2x.toFixed(1)} ${ty.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      mx = (sx + 3 * c1x + 3 * c2x + tx) / 8;
      my = (sy + 3 * sy + 3 * ty + ty) / 8;
      ax = sx;
      ay = sy;
      bx = tx;
      by = ty;
    }

    const sourceService =
      edge.processes?.[0] ??
      source.node.services[0]?.name ??
      (source.aggregated ? source.node.label : source.node.hostname ?? source.node.label);
    const targetPortService = target.node.services.find((service) => service.port === edge.port);
    const targetService =
      targetPortService?.name ??
      target.node.services[0]?.name ??
      (target.aggregated ? target.node.label : target.node.hostname ?? target.node.label);
    const systemA = source.systemId;
    const systemB = target.systemId;
    const crossSystem = systemA !== systemB;
    const fullLabel = `${sourceService} → ${targetService}:${edge.port}`;
    routed.push({
      edge,
      d,
      mx,
      my,
      ax,
      ay,
      bx,
      by,
      sourceId: source.id,
      targetId: target.id,
      sourceService,
      targetService,
      fullLabel,
      compactLabel: `:${edge.port}`,
      systemA,
      systemB,
      colorA: source.systemColor,
      colorB: target.systemColor,
      ratio: Math.min(1, edge.count / Math.max(1, maxEdgeCount)),
      failureRate: failureRateOf(edge),
      anomalous: isAnomalous(edge),
      crossSystem,
      external: Boolean(edge.external) || target.node.kind === 'external',
      systemEdge: false,
      rank: rankById.get(edge.id) ?? 999,
    });
  }

  // 静态只放端口小标签，避免密集重叠；完整标签在 hover / 聚焦时展示。
  const nodeRects = [...nodeById.values()].map((node) => ({
    x: node.x - 2,
    y: node.y - 2,
    w: node.w + 4,
    h: node.h + 4,
  }));
  const placedLabels: RoutedLabel[] = [];
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const labelCandidates = routed
    .filter((edge) => edge.rank < 18)
    .sort((a, b) => a.rank - b.rank);
  for (const edge of labelCandidates) {
    const text = edge.compactLabel;
    const w = measureText(text, 11) + 10;
    const h = 15;
    const anchors = [0.5, 0.36, 0.64];
    let candidate: RoutedLabel | null = null;
    for (const t of anchors) {
      const point = cubicPoint(edge.d, t);
      const rect = { x: point.x - w / 2, y: point.y - h / 2, w, h };
      if (rect.x < 4 || rect.x + rect.w > worldWidth - 4) continue;
      if (nodeRects.some((node) => overlaps(rect, node))) continue;
      if (placedLabels.some((label) => overlaps(rect, { x: label.x - label.w / 2, y: label.y - label.h / 2, w: label.w, h: label.h }))) continue;
      candidate = { edgeId: edge.edge.id, x: point.x, y: point.y, w, h, text };
      break;
    }
    if (candidate) placedLabels.push(candidate);
  }

  // 业务系统包围轮廓（同一层内按系统聚簇）。
  const groups: GroupHull[] = [];
  for (const tier of activeTiers) {
    const bySystem = new Map<string, PositionedNode[]>();
    for (const node of nodeById.values()) {
      if (node.tier !== tier || !node.systemId) continue;
      const key = `${node.systemId}|${Math.round(node.x)}`;
      const list = bySystem.get(key) ?? [];
      list.push(node);
      bySystem.set(key, list);
    }
    for (const [key, list] of bySystem) {
      const systemId = key.split('|')[0] ?? '';
      const minX = Math.min(...list.map((node) => node.x));
      const maxX = Math.max(...list.map((node) => node.x + node.w));
      const minY = Math.min(...list.map((node) => node.y));
      const maxY = Math.max(...list.map((node) => node.y + node.h));
      const index = systemIndex.get(systemId) ?? 0;
      groups.push({
        systemId,
        name: systemNames.get(systemId) ?? systemId,
        color: SYSTEM_COLORS[index % SYSTEM_COLORS.length] ?? SYSTEM_COLORS[0]!,
        tier,
        x: minX - 10,
        y: minY - 24,
        w: maxX - minX + 20,
        h: maxY - minY + 34,
        count: list.length,
        labelX: minX - 2,
        labelY: minY - 10,
      });
    }
  }

  const tierBands: TierBand[] = activeTiers.map((tier) => {
    const meta = TIER_META[tier];
    const width = tierWidths.get(tier) ?? geometry.cardW;
    const x = bandX.get(tier) ?? geometry.padX;
    let maxY = 0;
    for (const node of nodeById.values()) {
      if (node.tier === tier) maxY = Math.max(maxY, node.y + node.h);
    }
    return {
      key: tier,
      title: meta.title,
      en: meta.en,
      accent: meta.accent,
      x,
      y: 0,
      w: width + geometry.bandPad * 2,
      h: Math.max(geometry.headerH + geometry.padTop + 40, maxY - 0 + 26),
      count: tierNodes.get(tier)?.length ?? 0,
      systems: new Set((tierNodes.get(tier) ?? []).map((item) => item.node.appSystemId ?? '')).size,
    };
  });

  const systemLegend = systems.map((system, index) => {
    const nodes = [...nodeById.values()].filter((node) => node.systemId === system.id);
    return {
      id: system.id,
      name: system.name,
      color: SYSTEM_COLORS[index % SYSTEM_COLORS.length] ?? SYSTEM_COLORS[0]!,
      nodeCount: nodes.length,
      connections: nodes.reduce((sum, node) => sum + node.connections, 0) / 2,
    };
  });

  const totalConnections = view.edges.reduce((sum, edge) => sum + edge.count, 0);
  const failedConnections = view.edges.reduce((sum, edge) => sum + edge.failed, 0);
  const anomalies = routed.filter((edge) => edge.anomalous).length;

  return {
    width: worldWidth,
    height: worldHeight,
    nodes: [...nodeById.values()],
    nodeById,
    edges: routed.sort((a, b) => a.rank - b.rank),
    edgeById: new Map(routed.map((edge) => [edge.edge.id, edge])),
    labels: placedLabels,
    tiers: tierBands,
    groups,
    systemLegend,
    maxEdgeCount,
    totalConnections,
    failedConnections,
    anomalies,
  };
}

/** 后端把「未归属 / 未分配」也作为一个系统分组，展示时单独放右侧。 */
export function isUnassignedSystemName(name: string): boolean {
  return /未归属|未分配|未分类|未知|unassigned|unknown|n\/a/i.test(name.trim());
}

/**
 * 业务系统视图：按依赖方向把系统排成「上游入口 → 业务系统 → 下游依赖」，
 * 外部依赖与未归属主机单独放在右侧区域，系统间边全量标注。
 */
function computeSystemLayout(view: ViewGraph): TopoLayout {
  const systems = view.systems;
  const systemIndex = new Map(systems.map((system, index) => [system.id, index]));
  const aggregatedNodes = view.nodes.filter((item) => item.aggregated);
  const businessNodes = aggregatedNodes.filter(
    (item) => !isUnassignedSystemName(item.node.label),
  );
  const unassignedNodes = aggregatedNodes.filter((item) =>
    isUnassignedSystemName(item.node.label),
  );
  const looseNodes = view.nodes.filter((item) => !item.aggregated);

  const businessIds = new Set(businessNodes.map((item) => item.node.id));
  const outWeight = new Map<string, number>();
  const inWeight = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of businessIds) inDegree.set(id, 0);
  for (const edge of view.edges) {
    if (!businessIds.has(edge.source) || !businessIds.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    outWeight.set(edge.source, (outWeight.get(edge.source) ?? 0) + edge.count);
    inWeight.set(edge.target, (inWeight.get(edge.target) ?? 0) + edge.count);
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  // 按依赖方向分层：入度为 0 的系统放最上游，逐层推进；存在环时按出向流量补齐。
  const levels = new Map<string, number>();
  const queue = [...businessIds].filter((id) => (inDegree.get(id) ?? 0) === 0);
  queue.sort((a, b) => (outWeight.get(b) ?? 0) - (outWeight.get(a) ?? 0));
  for (const id of queue) levels.set(id, 0);
  const processed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    processed.add(id);
    for (const next of adjacency.get(id) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, (levels.get(id) ?? 0) + 1));
      const degree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  const remaining = [...businessIds].filter((id) => !processed.has(id));
  remaining.sort((a, b) => (outWeight.get(b) ?? 0) - (outWeight.get(a) ?? 0));
  const existingLevels = [...levels.values()];
  let nextLevel = (existingLevels.length > 0 ? Math.max(...existingLevels) : 0) + 1;
  for (const id of remaining) {
    levels.set(id, nextLevel);
    nextLevel += 1;
  }
  businessNodes.sort((a, b) => {
    const levelA = levels.get(a.node.id) ?? 0;
    const levelB = levels.get(b.node.id) ?? 0;
    if (levelA !== levelB) return levelA - levelB;
    const scoreA = (outWeight.get(a.node.id) ?? 0) - (inWeight.get(a.node.id) ?? 0);
    const scoreB = (outWeight.get(b.node.id) ?? 0) - (inWeight.get(b.node.id) ?? 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.node.label.localeCompare(b.node.label, 'zh-CN');
  });

  // 依赖层级决定列：层级不超过列数时一层一列（上游系统在左、下游系统在右）。
  const distinctLevels = [...new Set(businessNodes.map((item) => levels.get(item.node.id) ?? 0))].sort(
    (a, b) => a - b,
  );
  const maxCols = Math.min(3, Math.max(1, businessNodes.length));
  const columns: ViewNode[][] = Array.from({ length: maxCols }, () => []);
  if (businessNodes.length > 0) {
    if (distinctLevels.length <= maxCols) {
      distinctLevels.forEach((level, index) => {
        columns[Math.min(index, maxCols - 1)]!.push(
          ...businessNodes.filter((item) => (levels.get(item.node.id) ?? 0) === level),
        );
      });
    } else {
      const base = Math.floor(businessNodes.length / maxCols);
      const extra = businessNodes.length % maxCols;
      let cursor = 0;
      for (let index = 0; index < maxCols; index += 1) {
        const size = base + (index < extra ? 1 : 0);
        columns[index] = businessNodes.slice(cursor, cursor + size);
        cursor += size;
      }
    }
  }

  const edgeStats = new Map<string, { incoming: number; outgoing: number; failed: number; connections: number }>();
  for (const edge of view.edges) {
    const sourceStats = edgeStats.get(edge.source) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
    sourceStats.outgoing += edge.count;
    sourceStats.connections += edge.count;
    sourceStats.failed += edge.failed;
    edgeStats.set(edge.source, sourceStats);
    const targetStats = edgeStats.get(edge.target) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
    targetStats.incoming += edge.count;
    targetStats.connections += edge.count;
    targetStats.failed += edge.failed;
    edgeStats.set(edge.target, targetStats);
  }

  const padX = 24;
  const padBottom = 26;
  const padTop = 26;
  const headerH = 60;
  const colWidth = 224;
  const cardWidth = 208;
  const colGap = 155;
  const extraGap = 160;
  const extraWidth = 224;
  const nodeById = new Map<string, PositionedNode>();
  const groups: GroupHull[] = [];
  const tiers: TierBand[] = [];
  const columnBottoms: number[] = [];
  let maxBottom = headerH + padTop;

  const place = (
    item: ViewNode,
    x: number,
    y: number,
    width: number,
    height: number,
    systemId: string | null,
    color: string,
    index: number,
  ): PositionedNode => {
    const stats = edgeStats.get(item.node.id) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
    const positioned: PositionedNode = {
      node: item.node,
      id: item.node.id,
      x,
      y,
      w: width,
      h: height,
      tier: item.node.tier,
      systemId,
      systemColor: color,
      systemIndex: index,
      aggregated: item.aggregated,
      hostCount: item.hostCount,
      internalConnections: item.internalConnections,
      incoming: stats.incoming,
      outgoing: stats.outgoing,
      failed: stats.failed,
      connections: stats.connections,
    };
    nodeById.set(item.node.id, positioned);
    return positioned;
  };

  const tierAccents = ['#5b8cff', '#22d3ee', '#a78bfa', '#34d399'];
  for (let columnIndex = 0; columnIndex < maxCols; columnIndex += 1) {
    const column = columns[columnIndex] ?? [];
    let y = headerH + padTop;
    for (const item of column) {
      const card = cardLayout(item.node, true, 'system');
      const color = SYSTEM_COLORS[(systemIndex.get(item.node.appSystemId ?? '') ?? 0) % SYSTEM_COLORS.length] ?? SYSTEM_COLORS[0]!;
      place(
        item,
        padX + columnIndex * (colWidth + colGap) + (colWidth - card.w) / 2,
        y,
        card.w,
        card.h,
        item.node.appSystemId ?? null,
        color,
        systemIndex.get(item.node.appSystemId ?? '') ?? 0,
      );
      y += card.h + 30;
    }
    maxBottom = Math.max(maxBottom, y - 30);
    columnBottoms[columnIndex] = y - 30;
    const isFirst = columnIndex === 0;
    const isLast = columnIndex === maxCols - 1;
    const title =
      businessNodes.length <= 1 ? '业务系统' : isFirst ? '上游系统' : isLast ? '下游系统' : '业务系统';
    const en = businessNodes.length <= 1 ? 'SYSTEM' : isFirst ? 'UPSTREAM' : isLast ? 'DOWNSTREAM' : 'CORE';
    tiers.push({
      key: 'app',
      title,
      en,
      accent: tierAccents[columnIndex % tierAccents.length] ?? '#5b8cff',
      x: padX + columnIndex * (colWidth + colGap),
      y: 6,
      w: colWidth,
      h: 0,
      count: column.length,
      systems: column.length,
      icon: 'app',
      subLabel: `${column.length} 个业务系统`,
    });
  }
  if (businessNodes.length === 0) maxBottom = Math.max(maxBottom, headerH + 120);

  const extraGroupsDefinitions: { key: string; name: string; color: string; nodes: ViewNode[] }[] = [
    {
      key: 'external',
      name: '外部依赖',
      color: EXTERNAL_COLOR,
      nodes: looseNodes.filter((item) => item.node.kind === 'external' || item.node.inferred === true),
    },
    {
      key: 'unassigned',
      name: '未归属',
      color: UNASSIGNED_COLOR,
      nodes: unassignedNodes,
    },
    {
      key: 'other',
      name: '其他节点',
      color: '#94a3b8',
      nodes: looseNodes.filter((item) => !(item.node.kind === 'external' || item.node.inferred === true)),
    },
  ].filter((group) => group.nodes.length > 0);

  const extraCount = extraGroupsDefinitions.reduce((sum, group) => sum + group.nodes.length, 0);
  const extraX = padX + maxCols * colWidth + Math.max(0, maxCols - 1) * colGap + (extraCount > 0 ? extraGap : 0);
  let extraY = headerH + padTop;
  for (const group of extraGroupsDefinitions) {
    extraY += 34;
    const startY = extraY;
    const placedNodes: PositionedNode[] = [];
    for (const item of group.nodes) {
      const card = cardLayout(item.node, item.aggregated, 'system');
      const positioned = place(
        item,
        extraX + (extraWidth - card.w) / 2,
        extraY,
        card.w,
        card.h,
        item.node.appSystemId ?? null,
        group.color,
        item.node.appSystemId ? (systemIndex.get(item.node.appSystemId) ?? 0) : 98,
      );
      placedNodes.push(positioned);
      extraY += card.h + 22;
    }
    if (placedNodes.length > 0) {
      const minX = Math.min(...placedNodes.map((node) => node.x));
      const maxX = Math.max(...placedNodes.map((node) => node.x + node.w));
      const maxY = Math.max(...placedNodes.map((node) => node.y + node.h));
      groups.push({
        systemId: group.key,
        name: group.name,
        color: group.color,
        tier: 'external',
        x: minX - 12,
        y: startY - 30,
        w: maxX - minX + 24,
        h: maxY - (startY - 30) + 16,
        count: placedNodes.length,
        labelX: minX,
        labelY: startY - 12,
      });
    }
    extraY += 14;
    maxBottom = Math.max(maxBottom, extraY);
  }
  if (extraCount > 0) {
    tiers.push({
      key: 'external',
      title: '外部依赖 / 其他',
      en: 'EXTERNAL',
      accent: '#f59e0b',
      x: extraX - 14,
      y: 6,
      w: extraWidth,
      h: 0,
      count: extraCount,
      systems: extraGroupsDefinitions.length,
      icon: 'external',
      subLabel: '外部与未归属',
    });
  }

  const worldWidth = Math.max(
    720,
    (extraCount > 0 ? extraX + extraWidth : padX + maxCols * colWidth + Math.max(0, maxCols - 1) * colGap) + padX,
  );
  const worldHeight = Math.max(380, maxBottom + padBottom);
  // 列背景贴合内容高度，避免卡片下方出现一大片空色带。
  const finalTiers = tiers.map((tier) => {
    let bottom = 0;
    for (const node of nodeById.values()) {
      if (node.x + node.w < tier.x || node.x > tier.x + tier.w) continue;
      bottom = Math.max(bottom, node.y + node.h);
    }
    const contentBottom = bottom > 0 ? bottom : maxBottom;
    const height = Math.max(170, Math.min(worldHeight - 12, contentBottom + 24 - 6));
    return { ...tier, h: height };
  });

  const sortedEdges = [...view.edges].sort((a, b) => b.count - a.count);
  const rankById = new Map(sortedEdges.map((edge, index) => [edge.id, index]));
  const maxEdgeCount = sortedEdges[0]?.count ?? 1;
  const routed: RoutedEdge[] = [];
  const samePairIndex = new Map<string, number>();

  for (const edge of view.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const pairKey = `${edge.source}->${edge.target}`;
    const pairIndex = samePairIndex.get(pairKey) ?? 0;
    samePairIndex.set(pairKey, pairIndex + 1);
    const stagger = pairIndex * 10;
    let d: string;
    let mx: number;
    let my: number;
    let ax: number;
    let ay: number;
    let bx: number;
    let by: number;
    if (target.x > source.x + source.w * 0.5) {
      ax = source.x + source.w;
      ay = source.y + source.h / 2 + stagger * 0.4;
      bx = target.x - 3;
      by = target.y + target.h / 2 + stagger * 0.4;
      const dx = Math.max(60, (bx - ax) * 0.44);
      const c1x = ax + dx;
      const c1y = ay + stagger;
      const c2x = bx - dx;
      const c2y = by + stagger * 0.4;
      d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
      mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
      my = (ay + 3 * c1y + 3 * c2y + by) / 8;
    } else if (target.x + target.w < source.x + source.w * 0.5) {
      ax = source.x;
      ay = source.y + source.h / 2;
      bx = target.x + target.w + 3;
      by = target.y + target.h / 2;
      const bow = 96 + pairIndex * 14;
      const c1x = ax - 60;
      const c1y = ay + bow;
      const c2x = bx + 60;
      const c2y = by + bow;
      d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
      mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
      my = (ay + 3 * c1y + 3 * c2y + by) / 8;
    } else {
      ax = source.x + source.w;
      ay = source.y + source.h / 2 + stagger;
      bx = target.x + target.w;
      by = target.y + target.h / 2 + stagger;
      const bow = 84 + pairIndex * 12;
      const c1x = ax + bow;
      const c2x = bx + bow;
      d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${ay.toFixed(1)}, ${c2x.toFixed(1)} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
      mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
      my = (ay + 3 * ay + 3 * by + by) / 8;
    }
    const crossSystem = edge.source !== edge.target;
    const fullLabel = `${source.node.label} → ${target.node.label} · ${compactNumber(edge.count)}`;
    routed.push({
      edge,
      d,
      mx,
      my,
      ax,
      ay,
      bx,
      by,
      sourceId: source.id,
      targetId: target.id,
      sourceService: source.node.label,
      targetService: target.node.label,
      fullLabel,
      compactLabel: compactNumber(edge.count),
      systemA: source.systemId,
      systemB: target.systemId,
      colorA: source.systemColor,
      colorB: target.systemColor,
      ratio: Math.min(1, edge.count / Math.max(1, maxEdgeCount)),
      failureRate: failureOf(edge),
      anomalous: anomalousOf(edge),
      crossSystem,
      external: Boolean(edge.external) || target.node.kind === 'external',
      systemEdge: true,
      rank: rankById.get(edge.id) ?? 999,
    });
  }

  const nodeRects = [...nodeById.values()].map((node) => ({
    x: node.x - 2,
    y: node.y - 2,
    w: node.w + 4,
    h: node.h + 4,
  }));
  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const placedLabels: RoutedLabel[] = [];
  for (const edge of [...routed].sort((a, b) => a.rank - b.rank).slice(0, 18)) {
    const text = edge.fullLabel;
    const w = measureText(text, 11.5) + 18;
    const h = 20;
    let placed = false;
    for (const t of [0.5, 0.38, 0.62, 0.26, 0.74]) {
      const point = cubicPoint(edge.d, t);
      for (const offset of [0, -26, 26, -52, 52, -78, 78]) {
        const rect = { x: point.x - w / 2, y: point.y + offset - h / 2, w, h };
        if (rect.x < 6 || rect.x + rect.w > worldWidth - 6) continue;
        if (nodeRects.some((node) => overlaps(rect, node))) continue;
        if (placedLabels.some((label) => overlaps(rect, { x: label.x - label.w / 2, y: label.y - label.h / 2, w: label.w, h: label.h }))) continue;
        placedLabels.push({ edgeId: edge.edge.id, x: point.x, y: point.y + offset, w, h, text });
        placed = true;
        break;
      }
      if (placed) break;
    }
  }

  const systemLegend = systems.map((system, index) => {
    const nodes = [...nodeById.values()].filter((node) => node.systemId === system.id);
    return {
      id: system.id,
      name: system.name,
      color: SYSTEM_COLORS[index % SYSTEM_COLORS.length] ?? SYSTEM_COLORS[0]!,
      nodeCount: nodes.reduce((sum, node) => sum + node.hostCount, 0),
      connections: nodes.reduce((sum, node) => sum + node.connections, 0) / 2,
    };
  });

  return {
    width: worldWidth,
    height: worldHeight,
    nodes: [...nodeById.values()],
    nodeById,
    edges: routed.sort((a, b) => a.rank - b.rank),
    edgeById: new Map(routed.map((edge) => [edge.edge.id, edge])),
    labels: placedLabels,
    tiers: finalTiers,
    groups,
    systemLegend,
    maxEdgeCount,
    totalConnections: view.edges.reduce((sum, edge) => sum + edge.count, 0),
    failedConnections: view.edges.reduce((sum, edge) => sum + edge.failed, 0),
    anomalies: routed.filter((edge) => edge.anomalous).length,
  };
}

function anomalousOf(edge: TopologyEdge): boolean {
  return isAnomalous(edge);
}

function failureOf(edge: TopologyEdge): number {
  return failureRateOf(edge);
}

function cubicPoint(path: string, t: number): { x: number; y: number } {
  const numbers = path
    .replace(/[MC,]/g, ' ')
    .trim()
    .split(/\s+/)
    .map((value) => Number(value));
  const [sx = 0, sy = 0, c1x = 0, c1y = 0, c2x = 0, c2y = 0, tx = 0, ty = 0] = numbers;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * sx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * tx,
    y: mt * mt * mt * sy + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ty,
  };
}

export { compactNumber, failureRateOf, isAnomalous };
