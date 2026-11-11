/**
 * 访问拓扑布局 V2：平台浅色风格 + 业务系统横向泳道 + IT 分层列。
 *
 * 主机视图：每个业务系统一条横向泳道，顶部固定 6 个 IT 分层列
 * （接入 / 应用 / 中间件 / 数据 / 运维观测 / 外部），主机落在对应列。
 * 业务系统视图：按依赖方向把系统排成上游 → 下游的列，外部与未归属单独分组。
 *
 * 布局是纯函数，画布只负责绘制与交互。
 */
import { isManagementService } from './v3.js';
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

/** 平台风格业务系统配色（浅色/深色下都可读）。 */
export const SYSTEM_COLORS: readonly string[] = [
  '#2f6fed',
  '#0e9384',
  '#8b5cf6',
  '#d97706',
  '#dc5a5a',
  '#64748b',
];

export const EXTERNAL_COLOR = '#8a94a6';
export const UNASSIGNED_COLOR = '#7c8798';

export const TIER_ORDER: readonly TopologyTier[] = [
  'access',
  'app',
  'middleware',
  'data',
  'ops',
  'external',
];

export interface TierMeta {
  readonly title: string;
  readonly en: string;
  readonly accent: string;
  readonly hint: string;
}

export const TIER_META: Readonly<Record<TopologyTier, TierMeta>> = {
  access: { title: '接入层', en: 'ACCESS', accent: '#2f6fed', hint: '负载均衡 / 网关 / 反向代理' },
  app: { title: '应用层', en: 'APP', accent: '#0e9384', hint: '业务服务 / 应用进程' },
  middleware: { title: '中间件层', en: 'MIDDLEWARE', accent: '#8b5cf6', hint: '缓存 / 消息队列 / 注册中心' },
  data: { title: '数据层', en: 'DATA', accent: '#d97706', hint: '数据库 / 存储' },
  ops: { title: '运维观测层', en: 'OPS', accent: '#64748b', hint: '监控 / 日志 / 系统服务' },
  external: { title: '外部依赖', en: 'EXTERNAL', accent: '#8a94a6', hint: '第三方 API / 外部 IP' },
};

const LEGACY_TIER: Readonly<Record<string, TopologyTier>> = {
  ingress: 'access',
  infra: 'ops',
  access: 'access',
  app: 'app',
  middleware: 'middleware',
  data: 'data',
  ops: 'ops',
  external: 'external',
};

/** 旧图兜底：ingress→access、infra→ops。 */
export function normalizeTier(tier: string | undefined | null): TopologyTier {
  return LEGACY_TIER[String(tier)] ?? 'app';
}

export function tierRank(tier: TopologyTier): number {
  return TIER_ORDER.indexOf(tier);
}

const KIND_LABEL: Readonly<Record<TopologyNodeKind, string>> = {
  gateway: '网关',
  service: '应用服务',
  database: '数据库',
  cache: '缓存',
  mq: '消息队列',
  registry: '注册中心',
  storage: '存储',
  monitoring: '监控',
  logging: '日志',
  external: '外部服务',
  unknown: '主机',
};

export function kindLabel(kind: TopologyNodeKind): string {
  return KIND_LABEL[kind] ?? '主机';
}

export interface ProductTone {
  readonly bg: string;
  readonly fg: string;
  readonly border: string;
}

const PRODUCT_TONES: readonly { readonly keys: readonly string[]; readonly tone: ProductTone }[] = [
  { keys: ['nginx', 'haproxy', 'envoy', 'traefik'], tone: { bg: 'rgba(47, 111, 237, 0.1)', fg: '#1d4ed8', border: 'rgba(47, 111, 237, 0.28)' } },
  { keys: ['spring'], tone: { bg: 'rgba(14, 147, 132, 0.1)', fg: '#0f766e', border: 'rgba(14, 147, 132, 0.3)' } },
  { keys: ['mysql', 'postgres', 'oracle', 'sqlserver', 'mongodb', 'mariadb'], tone: { bg: 'rgba(217, 119, 6, 0.1)', fg: '#b45309', border: 'rgba(217, 119, 6, 0.3)' } },
  { keys: ['redis', 'memcached'], tone: { bg: 'rgba(220, 90, 90, 0.1)', fg: '#b91c1c', border: 'rgba(220, 90, 90, 0.3)' } },
  { keys: ['kafka', 'rabbitmq', 'rocketmq', 'pulsar'], tone: { bg: 'rgba(139, 92, 246, 0.1)', fg: '#6d28d9', border: 'rgba(139, 92, 246, 0.3)' } },
  { keys: ['nacos', 'consul', 'zookeeper', 'etcd'], tone: { bg: 'rgba(13, 148, 136, 0.1)', fg: '#0f766e', border: 'rgba(13, 148, 136, 0.3)' } },
  { keys: ['prometheus', 'grafana', 'zabbix', 'elastic', 'filebeat', 'loki', 'opensearch'], tone: { bg: 'rgba(100, 116, 139, 0.12)', fg: '#475569', border: 'rgba(100, 116, 139, 0.32)' } },
];

export function productTone(product: string | undefined): ProductTone {
  const value = (product ?? '').toLowerCase();
  for (const entry of PRODUCT_TONES) {
    if (entry.keys.some((key) => value.includes(key))) return entry.tone;
  }
  return { bg: 'rgba(100, 116, 139, 0.09)', fg: '#5b6b80', border: 'rgba(100, 116, 139, 0.22)' };
}

export function displayProduct(node: TopologyNode): string {
  if (node.product && node.product.trim()) return node.product.trim();
  if (node.systemService) return '系统服务';
  return kindLabel(node.kind);
}

// ---------------------------------------------------------------------------
// 视图投影
// ---------------------------------------------------------------------------

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
  readonly includeUnassigned: boolean;
  readonly hiddenUnassigned: number;
}

export interface BuildViewOptions {
  readonly includeUnassigned?: boolean;
}

export function isUnassignedSystemName(name: string | undefined): boolean {
  return /未归属|未分配|未分类|未知|unassigned|unknown|n\/a/i.test((name ?? '').trim());
}

export function isExternalNode(node: TopologyNode): boolean {
  return node.kind === 'external' || node.inferred === true || normalizeTier(node.tier) === 'external';
}

function serviceSignature(services: readonly TopologyServicePort[]): string {
  return services
    .map((service) => `${service.name}:${service.port}`)
    .sort()
    .join('|');
}

function aggregateSystemNode(system: TopologySystemGroup, hosts: readonly TopologyNode[]): ViewNode {
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
  const services = new Map<string, TopologyServicePort>();
  for (const host of hosts) {
    for (const service of host.services) services.set(`${service.name}:${service.port}`, service);
  }
  const products = [...new Set(hosts.map((host) => host.product).filter((item): item is string => Boolean(item)))];
  const anomalies = [...new Set(hosts.flatMap((host) => host.anomalies ?? []))].slice(0, 3);
  const status: TopologyNode['status'] = hosts.some((host) => host.status === 'online')
    ? 'online'
    : hosts.every((host) => host.status === 'offline')
      ? 'offline'
      : 'unknown';
  const node: TopologyNode = {
    id: `sys:${system.id}`,
    label: system.name,
    kind: 'service',
    tier: 'app',
    status,
    services: [...services.values()].slice(0, 6),
    metrics,
    appSystemId: system.id,
    appSystemName: system.name,
    product: products.slice(0, 3).join(' / '),
    role: `${hosts.length} 台主机 · 内部链路 ${hosts.reduce((sum, host) => sum + host.metrics.active, 0)} 条`,
    inferred: false,
    note: '由同一业务系统的主机聚合而成',
    ...(anomalies.length > 0 ? { anomalies } : {}),
  };
  return { node, aggregated: true, hostCount: hosts.length, internalConnections: 0 };
}

export function buildViewGraph(
  graph: TopologyGraph,
  mode: TopoViewMode,
  options: BuildViewOptions = {},
): ViewGraph {
  const includeUnassigned = options.includeUnassigned ?? false;
  const unassignedSystemIds = new Set(
    graph.systems.filter((system) => isUnassignedSystemName(system.name)).map((system) => system.id),
  );
  const isUnassignedHost = (node: TopologyNode): boolean => {
    if (isExternalNode(node)) return false;
    if (node.appSystemId === null || node.appSystemId === undefined) return true;
    return unassignedSystemIds.has(node.appSystemId);
  };
  const visible = (node: TopologyNode): boolean => {
    if (isExternalNode(node)) return true;
    if (includeUnassigned) return true;
    return !isUnassignedHost(node);
  };
  const nodes = graph.nodes.filter(visible);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const systemIdByHost = new Map<string, string>();
  for (const node of nodes) {
    if (node.appSystemId) systemIdByHost.set(node.id, node.appSystemId);
  }
  const hiddenUnassigned = graph.nodes.filter(isUnassignedHost).length;

  if (mode === 'host') {
    return {
      graph,
      mode,
      nodes: nodes.map((node) => ({
        node: {
          ...node,
          tier: normalizeTier(node.tier),
          ...(isUnassignedHost(node)
            ? { appSystemId: null, appSystemName: '未归属主机' }
            : {}),
        },
        aggregated: false,
        hostCount: 1,
        internalConnections: 0,
      })),
      edges,
      systems: graph.systems,
      systemIdByHost,
      includeUnassigned,
      hiddenUnassigned,
    };
  }

  const systems = graph.systems.filter((system) => {
    if (!includeUnassigned && isUnassignedSystemName(system.name)) return false;
    return nodes.some((node) => node.appSystemId === system.id || system.nodeIds.includes(node.id));
  });
  const known = new Set(systems.map((system) => system.id));
  const systemNodes: ViewNode[] = [];
  const hostToView = new Map<string, string>();
  const internal = new Map<string, number>();
  for (const system of systems) {
    const hosts = nodes.filter(
      (node) => node.appSystemId === system.id || system.nodeIds.includes(node.id),
    );
    for (const host of hosts) hostToView.set(host.id, `sys:${system.id}`);
    systemNodes.push(aggregateSystemNode(system, hosts));
  }
  for (const node of nodes) {
    if (node.appSystemId && known.has(node.appSystemId)) continue;
    hostToView.set(node.id, node.id);
    systemNodes.push({ node, aggregated: false, hostCount: 1, internalConnections: 0 });
  }

  const aggregatedEdges = new Map<string, TopologyEdge & { weight: number }>();
  for (const edge of edges) {
    const source = hostToView.get(edge.source);
    const target = hostToView.get(edge.target);
    if (!source || !target) continue;
    if (source === target) {
      internal.set(source, (internal.get(source) ?? 0) + edge.count);
      continue;
    }
    const key = `${source}->${target}`;
    const current = aggregatedEdges.get(key);
    if (!current) {
      aggregatedEdges.set(key, {
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
      aggregatedEdges.set(key, {
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
  const edgesOut: TopologyEdge[] = [...aggregatedEdges.values()].map(({ weight: _weight, ...edge }) => ({
    ...edge,
    label: `${edge.count.toLocaleString('zh-CN')} 次连接`,
  }));
  const viewNodes = systemNodes.map((item) =>
    item.aggregated ? { ...item, internalConnections: internal.get(item.node.id) ?? 0 } : item,
  );
  return {
    graph,
    mode,
    nodes: viewNodes,
    edges: edgesOut,
    systems: systems.map((system) => ({ ...system, nodeIds: [`sys:${system.id}`] })),
    systemIdByHost: hostToView,
    includeUnassigned,
    hiddenUnassigned,
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

export function wrapLines(text: string, maxWidth: number, fontSize: number, maxLines = 2): string[] {
  if (measureText(text, fontSize) <= maxWidth) return [text];
  const breaks = new Set<number>();
  for (let index = 1; index < text.length; index += 1) {
    const previous = text[index - 1] ?? '';
    const current = text[index] ?? '';
    if (['-', '_', '.', ' ', '/'].includes(previous)) breaks.add(index);
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
      if (width + units * fontSize > maxWidth) break;
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

function compactNumber(value: number): string {
  if (value >= 100_000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatConnections(value: number): string {
  return compactNumber(value);
}

export function serviceLabel(service: TopologyServicePort): string {
  const name = service.name.trim();
  const port = String(service.port);
  if (!name || name === port) return `:${port}`;
  if (/^port\s*\d*$/i.test(name) || /^\d+$/.test(name)) return `:${port}`;
  if (name.endsWith(`:${port}`)) return name;
  return `${name}:${port}`;
}

function failureRateOf(edge: TopologyEdge): number {
  const base = Math.max(edge.opened, edge.count, 1);
  return edge.failed / base;
}

function isAnomalousEdge(edge: TopologyEdge): boolean {
  return edge.failed > 0 && (failureRateOf(edge) >= 0.05 || edge.failed >= 20);
}

// ---------------------------------------------------------------------------
// 主机卡片几何
// ---------------------------------------------------------------------------

export interface HostCardLayout {
  readonly w: number;
  readonly h: number;
  readonly titleLines: readonly string[];
  readonly titleFont: number;
  readonly titleLineHeight: number;
  readonly titleY: number;
  readonly titleWidth: number;
  readonly titleCompress: boolean;
  readonly productText: string;
  readonly productMaxWidth: number;
  readonly roleText: string;
  readonly roleLines: readonly string[];
  readonly roleY: number;
  readonly roleLineHeight: number;
  readonly chipY: number;
  readonly chips: readonly string[];
  readonly hiddenChips: number;
  readonly moreLabel: string;
  readonly metricsY: number;
  readonly metricsFont: number;
}

export const HOST_CARD_W = 120;
export const SYSTEM_CARD_W = 208;

export function hostCardLayout(node: TopologyNode, compact = true): HostCardLayout {
  const w = HOST_CARD_W;
  const titleMax = w - 16;
  const titleFont = 13.5;
  const titleLineHeight = 14;
  const rawTitleWidth = measureText(node.label, titleFont);
  const compressible = rawTitleWidth > titleMax && rawTitleWidth <= titleMax * 1.55;
  const lines = compressible ? [node.label] : wrapLines(node.label, titleMax, titleFont, 2);
  const titleWidth = compressible ? titleMax : rawTitleWidth;
  const titleY = 31;
  const roleText = truncateText(node.role ?? (node.systemService ? '系统服务' : kindLabel(node.kind)), w - 16, 12);
  const roleLines = compact
    ? [roleText]
    : wrapLines(node.role ?? (node.systemService ? '系统服务' : kindLabel(node.kind)), w - 16, 12, 2);
  const roleLineHeight = 13;
  const roleY = titleY + (lines.length - 1) * titleLineHeight + 12;
  const chipY = roleY + (roleLines.length - 1) * roleLineHeight + 3;
  const metricsY = chipY + 14 + 11;
  const h = metricsY + 5;
  const businessServices = node.services.filter((service) => !isManagementService(service));
  const serviceTexts = businessServices.map((service) => serviceLabel(service));
  const chips: string[] = [];
  let used = 0;
  const maxChips = 2;
  const reserveMore = businessServices.length > 1 ? 18 : 0;
  for (const text of serviceTexts) {
    const width = Math.round(measureText(text, 11.5) + 10);
    if (chips.length >= maxChips || used + width + 4 + reserveMore > w - 16) {
      if (chips.length === 0 && width + 4 <= w - 12) {
        chips.push(text);
      }
      break;
    }
    chips.push(text);
    used += width + 4;
  }
  const hiddenChips = Math.max(0, businessServices.length - chips.length);
  return {
    w,
    h,
    titleLines: lines.length > 0 ? lines : [node.label],
    titleFont,
    titleLineHeight,
    titleY,
    titleWidth,
    titleCompress: compressible,
    productText: displayProduct(node),
    productMaxWidth: w - 26,
    roleText: roleLines[0] ?? '',
    roleLines,
    roleY,
    roleLineHeight,
    chipY,
    chips,
    hiddenChips,
    moreLabel: hiddenChips > 0 ? `+${hiddenChips} 项` : '',
    metricsY,
    metricsFont: 11,
  };
}

export function systemCardLayout(node: TopologyNode): { w: number; h: number; titleLines: readonly string[]; titleFont: number } {
  const w = SYSTEM_CARD_W;
  const titleFont = 16;
  const titleLines = wrapLines(node.label, w - 40, titleFont, 2);
  return { w, h: titleLines.length > 1 ? 122 : 108, titleLines, titleFont };
}

// ---------------------------------------------------------------------------
// 布局数据结构
// ---------------------------------------------------------------------------

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
  readonly laneId: string;
  readonly aggregated: boolean;
  readonly hostCount: number;
  readonly internalConnections: number;
  readonly incoming: number;
  readonly outgoing: number;
  readonly failed: number;
  readonly connections: number;
  readonly card: HostCardLayout | null;
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

export interface LaneBand {
  readonly id: string;
  readonly name: string;
  readonly kind: 'system' | 'external' | 'unassigned';
  readonly criticality?: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly nodeCount: number;
  readonly hostCount: number;
  readonly connections: number;
  readonly failures: number;
  readonly anomalyCount: number;
  readonly tiers: readonly TopologyTier[];
}

export interface ColumnBand {
  readonly id: string;
  /** 主机视图是 IT 分层；业务系统视图用于取图标/配色。 */
  readonly key: TopologyTier;
  readonly title: string;
  readonly en: string;
  readonly hint: string;
  readonly accent: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly count: number;
  readonly subLabel?: string;
}

export interface CellBand {
  readonly laneId: string;
  readonly tier: TopologyTier;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly count: number;
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
  readonly mode: TopoViewMode;
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  readonly nodes: readonly PositionedNode[];
  readonly nodeById: ReadonlyMap<string, PositionedNode>;
  readonly edges: readonly RoutedEdge[];
  readonly edgeById: ReadonlyMap<string, RoutedEdge>;
  readonly labels: readonly RoutedLabel[];
  readonly columns: readonly ColumnBand[];
  readonly lanes: readonly LaneBand[];
  readonly cells: readonly CellBand[];
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
// 主机视图：横向泳道
// ---------------------------------------------------------------------------

const LANE_HEADER_W = 132;
const LANE_PAD_Y = 10;
const LANE_MIN_H = 98;
const COL_PAD = 8;
const COL_GAP = 8;
const CELL_CARD_GAP = 8;
const CARDS_PER_ROW = 2;
const HEADER_H = 66;

interface LaneDraft {
  readonly id: string;
  readonly name: string;
  readonly kind: 'system' | 'external' | 'unassigned';
  readonly criticality?: string;
  readonly color: string;
  readonly nodes: ViewNode[];
}

function laneKeyFor(node: TopologyNode): string {
  if (isExternalNode(node)) return '__external__';
  return node.appSystemId ?? '__unassigned__';
}

function computeHostLayout(view: ViewGraph, compactCards: boolean): TopoLayout {
  const graph = view.graph;
  const systemIndex = new Map(graph.systems.map((system, index) => [system.id, index]));
  const systemName = new Map(graph.systems.map((system) => [system.id, system.name]));
  const laneDrafts = new Map<string, LaneDraft>();
  for (const item of view.nodes) {
    const key = laneKeyFor(item.node);
    const isExternal = key === '__external__';
    const isUnassigned = key === '__unassigned__';
    const index = item.node.appSystemId ? (systemIndex.get(item.node.appSystemId) ?? 0) : 0;
    const lane = laneDrafts.get(key) ?? {
      id: key,
      name: isExternal ? '外部依赖' : isUnassigned ? '未归属主机' : systemName.get(key) ?? item.node.appSystemName ?? key,
      kind: isExternal ? 'external' : isUnassigned ? 'unassigned' : 'system',
      color: isExternal ? EXTERNAL_COLOR : isUnassigned ? UNASSIGNED_COLOR : SYSTEM_COLORS[index % SYSTEM_COLORS.length] ?? SYSTEM_COLORS[0]!,
      ...(item.node.appSystemId && graph.systems.find((system) => system.id === item.node.appSystemId)?.criticality
        ? { criticality: graph.systems.find((system) => system.id === item.node.appSystemId)?.criticality as string }
        : {}),
      nodes: [],
    };
    lane.nodes.push(item);
    laneDrafts.set(key, lane);
  }
  const laneOrder: string[] = [
    ...graph.systems.map((system) => system.id).filter((id) => laneDrafts.has(id)),
    ...(laneDrafts.has('__unassigned__') ? ['__unassigned__'] : []),
    ...(laneDrafts.has('__external__') ? ['__external__'] : []),
  ];
  const lanes = laneOrder.map((id) => laneDrafts.get(id)!).filter(Boolean);

  // 列宽由各泳道单元格内容决定：同格最多横向 2 张卡，超过则换行。
  const cellNodes = new Map<string, ViewNode[]>();
  for (const lane of lanes) {
    if (lane.kind === 'external') continue;
    for (const item of lane.nodes) {
      const key = `${lane.id}::${normalizeTier(item.node.tier)}`;
      const list = cellNodes.get(key) ?? [];
      list.push(item);
      cellNodes.set(key, list);
    }
  }
  const columnWidths = new Map<TopologyTier, number>();
  for (const tier of TIER_ORDER) {
    let maxCards = 1;
    for (const lane of lanes) {
      const count = cellNodes.get(`${lane.id}::${tier}`)?.length ?? 0;
      if (count > 0) maxCards = Math.max(maxCards, Math.min(CARDS_PER_ROW, count));
    }
    columnWidths.set(tier, maxCards * HOST_CARD_W + (maxCards - 1) * CELL_CARD_GAP + COL_PAD * 2);
  }
  // 空列压缩到窄列，避免右侧出现大片空白；有节点的列按卡片数取宽。
  for (const tier of TIER_ORDER) {
    const width = columnWidths.get(tier) ?? HOST_CARD_W + COL_PAD * 2;
    const hasNodes = view.nodes.some((item) => normalizeTier(item.node.tier) === tier);
    columnWidths.set(tier, Math.max(width, hasNodes ? 136 : 120));
  }

  interface RawColumn {
    readonly key: TopologyTier;
    readonly title: string;
    readonly en: string;
    readonly hint: string;
    readonly accent: string;
    readonly x: number;
    readonly w: number;
    readonly count: number;
  }
  const rawColumns: RawColumn[] = [];
  let cursor = LANE_HEADER_W;
  for (const tier of TIER_ORDER) {
    const meta = TIER_META[tier];
    const w = columnWidths.get(tier) ?? 200;
    const count =
      tier === 'external'
        ? view.graph.stats.externalCount ?? view.nodes.filter((item) => normalizeTier(item.node.tier) === tier).length
        : view.nodes.filter((item) => normalizeTier(item.node.tier) === tier).length;
    rawColumns.push({ key: tier, title: meta.title, en: meta.en, hint: meta.hint, accent: meta.accent, x: cursor, w, count });
    cursor += w + COL_GAP;
  }
  const columns = rawColumns;
  const worldWidth = Math.max(760, cursor - COL_GAP + 26);

  // 每个单元格排成若干行（每行最多 2 张卡）。
  interface PlacedCell {
    readonly lane: LaneDraft;
    readonly tier: TopologyTier;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly rows: ViewNode[][];
    readonly rowHeights: number[];
    readonly h: number;
  }
  const placements: { laneId: string; node: ViewNode; x: number; y: number; w: number; h: number; tier: TopologyTier; card: HostCardLayout }[] = [];
  const cells: CellBand[] = [];
  const laneBands: LaneBand[] = [];
  let laneY = HEADER_H + 12;
  for (const lane of lanes) {
    if (lane.kind === 'external') {
      const externalIds = new Set(lane.nodes.map((item) => item.node.id));
      const barycenter = new Map<string, { total: number; weight: number }>();
      for (const edge of view.edges) {
        const externalId = externalIds.has(edge.source)
          ? edge.source
          : externalIds.has(edge.target)
            ? edge.target
            : null;
        if (!externalId) continue;
        const innerId = externalId === edge.source ? edge.target : edge.source;
        const inner = view.nodes.find((item) => item.node.id === innerId);
        if (!inner) continue;
        const columnIndex = columns.findIndex((column) => column.key === normalizeTier(inner.node.tier));
        const current = barycenter.get(externalId) ?? { total: 0, weight: 0 };
        current.total += Math.max(0, columnIndex) * Math.max(1, edge.count);
        current.weight += Math.max(1, edge.count);
        barycenter.set(externalId, current);
      }
      const externalNodes = [...lane.nodes].sort((a, b) => {
        const wa = barycenter.get(a.node.id);
        const wb = barycenter.get(b.node.id);
        const va = wa && wa.weight > 0 ? wa.total / wa.weight : 99;
        const vb = wb && wb.weight > 0 ? wb.total / wb.weight : 99;
        return va === vb ? (a.node.ip ?? a.node.label).localeCompare(b.node.ip ?? b.node.label, 'zh-CN') : va - vb;
      });
      const startX = LANE_HEADER_W + 14;
      const maxPerRow = Math.max(
        4,
        Math.min(6, Math.floor((worldWidth - startX - 20) / (HOST_CARD_W + CELL_CARD_GAP))),
      );
      let x = startX;
      let y = laneY + LANE_PAD_Y;
      let rowHeight = 0;
      let rowCount = 0;
      for (const item of externalNodes) {
        const card = hostCardLayout(item.node, compactCards);
        if (rowCount >= maxPerRow) {
          x = startX;
          y += rowHeight + CELL_CARD_GAP;
          rowHeight = 0;
          rowCount = 0;
        }
        placements.push({ laneId: lane.id, node: item, x, y, w: HOST_CARD_W, h: card.h, tier: 'external', card });
        x += HOST_CARD_W + CELL_CARD_GAP;
        rowHeight = Math.max(rowHeight, card.h);
        rowCount += 1;
      }
      const laneH = Math.max(LANE_MIN_H, y - laneY + rowHeight + LANE_PAD_Y);
      const laneNodes = placements.filter((item) => item.laneId === lane.id);
      const laneNodeIds = new Set(laneNodes.map((item) => item.node.node.id));
      let connections = 0;
      let failures = 0;
      for (const edge of view.edges) {
        if (laneNodeIds.has(edge.source) || laneNodeIds.has(edge.target)) {
          connections += edge.count;
          failures += edge.failed;
        }
      }
      laneBands.push({
        id: lane.id,
        name: lane.name,
        kind: lane.kind,
        color: lane.color,
        x: 0,
        y: laneY,
        w: worldWidth,
        h: laneH,
        nodeCount: laneNodes.length,
        hostCount: view.graph.stats.externalCount ?? laneNodes.length,
        connections,
        failures,
        anomalyCount: laneNodes.filter((item) => (item.node.node.anomalies?.length ?? 0) > 0).length,
        tiers: ['external'],
      });
      laneY += laneH;
      continue;
    }
    const cellDrafts: PlacedCell[] = [];
    for (const column of columns) {
      const list = (cellNodes.get(`${lane.id}::${column.key}`) ?? []).slice().sort((a, b) =>
        a.node.label.localeCompare(b.node.label, 'zh-CN'),
      );
      if (list.length === 0) continue;
      const rows: ViewNode[][] = [];
      for (let index = 0; index < list.length; index += CARDS_PER_ROW) {
        rows.push(list.slice(index, index + CARDS_PER_ROW));
      }
      const rowHeights = rows.map((row) => Math.max(...row.map((item) => hostCardLayout(item.node, compactCards).h)));
      const contentH = rowHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, rows.length - 1) * CELL_CARD_GAP;
      const cellW = Math.max(...rows.map((row) => row.length)) * HOST_CARD_W + (Math.max(...rows.map((row) => row.length)) - 1) * CELL_CARD_GAP;
      cellDrafts.push({
        lane,
        tier: column.key,
        x: column.x + COL_PAD,
        y: 0,
        w: cellW,
        rows,
        rowHeights,
        h: contentH,
      });
    }
    const contentH = cellDrafts.length > 0 ? Math.max(...cellDrafts.map((cell) => cell.h)) : 0;
    const laneH = Math.max(LANE_MIN_H, contentH + LANE_PAD_Y * 2);
    for (const cell of cellDrafts) {
      let y = laneY + LANE_PAD_Y;
      cell.rows.forEach((row, rowIndex) => {
        const rowH = cell.rowHeights[rowIndex] ?? 0;
        const rowWidth = row.length * HOST_CARD_W + (row.length - 1) * CELL_CARD_GAP;
        row.forEach((item, cardIndex) => {
          const card = hostCardLayout(item.node, compactCards);
          placements.push({
            laneId: lane.id,
            node: item,
            x: cell.x + (cell.w - rowWidth) / 2 + cardIndex * (HOST_CARD_W + CELL_CARD_GAP),
            y,
            w: HOST_CARD_W,
            h: card.h,
            tier: cell.tier,
            card,
          });
        });
        y += rowH + CELL_CARD_GAP;
      });
      cells.push({
        laneId: lane.id,
        tier: cell.tier,
        x: cell.x - 4,
        y: laneY + LANE_PAD_Y - 4,
        w: cell.w + 8,
        h: cell.h + 8,
        count: cell.rows.reduce((sum, row) => sum + row.length, 0),
      });
    }
    const laneNodes = placements.filter((item) => item.laneId === lane.id);
    const laneNodeIds = new Set(laneNodes.map((item) => item.node.node.id));
    let connections = 0;
    let failures = 0;
    for (const edge of view.edges) {
      if (laneNodeIds.has(edge.source) || laneNodeIds.has(edge.target)) {
        connections += edge.count;
        failures += edge.failed;
      }
    }
    const anomalyCount = laneNodes.filter((item) => (item.node.node.anomalies?.length ?? 0) > 0).length;
    const tiers = [...new Set(laneNodes.map((item) => item.tier))];
    laneBands.push({
      id: lane.id,
      name: lane.name,
      kind: lane.kind,
      ...(lane.criticality ? { criticality: lane.criticality } : {}),
      color: lane.color,
      x: 0,
      y: laneY,
      w: worldWidth,
      h: laneH,
      nodeCount: laneNodes.length,
      hostCount: laneNodes.reduce((sum, item) => sum + item.node.hostCount, 0),
      connections,
      failures,
      anomalyCount,
      tiers,
    });
    laneY += laneH;
  }
  const worldHeight = Math.max(360, laneY + 20);

  const nodeById = new Map<string, PositionedNode>();
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
  for (const item of placements) {
    const stats = edgeStats.get(item.node.node.id) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
    nodeById.set(item.node.node.id, {
      node: item.node.node,
      id: item.node.node.id,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      tier: item.tier,
      systemId: item.node.node.appSystemId ?? null,
      systemColor: item.node.node.appSystemId
        ? SYSTEM_COLORS[(systemIndex.get(item.node.node.appSystemId) ?? 0) % SYSTEM_COLORS.length] ?? SYSTEM_COLORS[0]!
        : isExternalNode(item.node.node)
          ? EXTERNAL_COLOR
          : UNASSIGNED_COLOR,
      systemIndex: item.node.node.appSystemId ? (systemIndex.get(item.node.node.appSystemId) ?? 0) : 98,
      laneId: item.laneId,
      aggregated: false,
      hostCount: 1,
      internalConnections: 0,
      incoming: stats.incoming,
      outgoing: stats.outgoing,
      failed: stats.failed,
      connections: stats.connections,
      card: item.card,
    });
  }

  const routed = routeEdges(view, nodeById, false);
  const routedLabels: RoutedLabel[] = [];
  const systemLegend = graph.systems
    .map((system, index) => {
      const nodes = [...nodeById.values()].filter((node) => node.systemId === system.id);
      return {
        id: system.id,
        name: system.name,
        color: SYSTEM_COLORS[index % SYSTEM_COLORS.length] ?? SYSTEM_COLORS[0]!,
        nodeCount: nodes.length,
        connections: nodes.reduce((sum, node) => sum + node.connections, 0) / 2,
      };
    })
    .filter((system) => system.nodeCount > 0);

  const hostColumns: ColumnBand[] = rawColumns.map((column) => ({
    ...column,
    id: `tier:${column.key}`,
    y: 0,
    h: worldHeight,
  }));

  return {
    mode: 'host',
    width: worldWidth,
    height: worldHeight,
    headerHeight: HEADER_H,
    nodes: [...nodeById.values()],
    nodeById,
    edges: routed.sort((a, b) => a.rank - b.rank),
    edgeById: new Map(routed.map((edge) => [edge.edge.id, edge])),
    labels: routedLabels,
    columns: hostColumns,
    lanes: laneBands,
    cells,
    groups: [],
    systemLegend,
    maxEdgeCount: Math.max(1, ...view.edges.map((edge) => edge.count)),
    totalConnections: view.edges.reduce((sum, edge) => sum + edge.count, 0),
    failedConnections: view.edges.reduce((sum, edge) => sum + edge.failed, 0),
    anomalies: routed.filter((edge) => edge.anomalous).length,
  };
}

// ---------------------------------------------------------------------------
// 业务系统视图：依赖方向列
// ---------------------------------------------------------------------------

function computeSystemLayout(view: ViewGraph): TopoLayout {
  const graph = view.graph;
  const systemIndex = new Map(graph.systems.map((system, index) => [system.id, index]));
  const aggregatedNodes = view.nodes.filter((item) => item.aggregated);
  const businessNodes = aggregatedNodes.filter((item) => !isUnassignedSystemName(item.node.label));
  const unassignedNodes = aggregatedNodes.filter((item) => isUnassignedSystemName(item.node.label));
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
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
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
  let nextLevel = Math.max(0, ...[...levels.values()]) + 1;
  for (const id of remaining) {
    levels.set(id, nextLevel);
    nextLevel += 1;
  }
  businessNodes.sort((a, b) => {
    const levelA = levels.get(a.node.id) ?? 0;
    const levelB = levels.get(b.node.id) ?? 0;
    if (levelA !== levelB) return levelA - levelB;
    return a.node.label.localeCompare(b.node.label, 'zh-CN');
  });
  const distinctLevels = [...new Set(businessNodes.map((item) => levels.get(item.node.id) ?? 0))].sort((a, b) => a - b);
  const maxCols = Math.min(3, Math.max(1, businessNodes.length));
  const columnsNodes: ViewNode[][] = Array.from({ length: maxCols }, () => []);
  if (businessNodes.length > 0) {
    if (distinctLevels.length <= maxCols) {
      distinctLevels.forEach((level, index) => {
        columnsNodes[Math.min(index, maxCols - 1)]!.push(
          ...businessNodes.filter((item) => (levels.get(item.node.id) ?? 0) === level),
        );
      });
    } else {
      let cursor = 0;
      for (let index = 0; index < maxCols; index += 1) {
        const size = Math.ceil((businessNodes.length - cursor) / (maxCols - index));
        columnsNodes[index] = businessNodes.slice(cursor, cursor + size);
        cursor += size;
      }
    }
  }

  const padX = 30;
  const headerH = 60;
  const colWidth = 236;
  const colGap = 132;
  const cardW = SYSTEM_CARD_W;
  const nodeById = new Map<string, PositionedNode>();
  const systemColors = SYSTEM_COLORS;
  const columns: ColumnBand[] = [];
  const groups: GroupHull[] = [];
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
  const placeSystem = (
    item: ViewNode,
    x: number,
    y: number,
    color: string,
    index: number,
  ): PositionedNode => {
    const card = systemCardLayout(item.node);
    const stats = edgeStats.get(item.node.id) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
    const positioned: PositionedNode = {
      node: item.node,
      id: item.node.id,
      x,
      y,
      w: card.w,
      h: card.h,
      tier: 'app',
      systemId: item.node.appSystemId ?? null,
      systemColor: color,
      systemIndex: index,
      laneId: item.node.appSystemId ?? item.node.id,
      aggregated: true,
      hostCount: item.hostCount,
      internalConnections: item.internalConnections,
      incoming: stats.incoming,
      outgoing: stats.outgoing,
      failed: stats.failed,
      connections: stats.connections,
      card: null,
    };
    nodeById.set(item.node.id, positioned);
    return positioned;
  };

  let maxBottom = headerH + 24;
  columnsNodes.forEach((column, index) => {
    const tierTitle = businessNodes.length <= 1 ? '业务系统' : index === 0 ? '上游系统' : index === maxCols - 1 ? '下游系统' : '业务系统';
    const en = businessNodes.length <= 1 ? 'SYSTEM' : index === 0 ? 'UPSTREAM' : index === maxCols - 1 ? 'DOWNSTREAM' : 'CORE';
    const x = padX + index * (colWidth + colGap);
    let y = headerH + 28;
    for (const item of column) {
      const color = systemColors[(systemIndex.get(item.node.appSystemId ?? '') ?? 0) % systemColors.length] ?? systemColors[0]!;
      const positioned = placeSystem(item, x + (colWidth - cardW) / 2, y, color, systemIndex.get(item.node.appSystemId ?? '') ?? 0);
      y += positioned.h + 30;
    }
    maxBottom = Math.max(maxBottom, y - 30);
    columns.push({
      id: `sys-col-${index}`,
      key: 'app',
      title: tierTitle,
      en,
      hint: index === 0 ? '被依赖的上游系统' : index === maxCols - 1 ? '依赖上游的系统' : '业务系统',
      accent: systemColors[index % systemColors.length] ?? SYSTEM_COLORS[0]!,
      x,
      y: 12,
      w: colWidth,
      h: 0,
      count: column.length,
      subLabel: `${column.length} 个系统`,
    });
  });

  const extraDefinitions = [
    { key: 'external', name: '外部依赖', color: EXTERNAL_COLOR, nodes: looseNodes.filter((item) => isExternalNode(item.node)) },
    { key: 'unassigned', name: '未归属', color: UNASSIGNED_COLOR, nodes: unassignedNodes },
    { key: 'other', name: '其他节点', color: '#94a3b8', nodes: looseNodes.filter((item) => !isExternalNode(item.node)) },
  ].filter((group) => group.nodes.length > 0);
  const extraCount = extraDefinitions.reduce((sum, group) => sum + group.nodes.length, 0);
  const extraX = padX + maxCols * colWidth + Math.max(0, maxCols - 1) * colGap + (extraCount > 0 ? 120 : 0);
  let extraY = headerH + 40;
  for (const group of extraDefinitions) {
    const startY = extraY;
    const placed: PositionedNode[] = [];
    for (const item of group.nodes) {
      const card = systemCardLayout(item.node);
      const positioned: PositionedNode = {
        node: item.node,
        id: item.node.id,
        x: extraX,
        y: extraY,
        w: card.w,
        h: card.h,
        tier: normalizeTier(item.node.tier),
        systemId: item.node.appSystemId ?? null,
        systemColor: group.color,
        systemIndex: 98,
        laneId: group.key,
        aggregated: item.aggregated,
        hostCount: item.hostCount,
        internalConnections: item.internalConnections,
        incoming: 0,
        outgoing: 0,
        failed: 0,
        connections: 0,
        card: null,
      };
      const stats = edgeStats.get(item.node.id) ?? { incoming: 0, outgoing: 0, failed: 0, connections: 0 };
      nodeById.set(item.node.id, {
        ...positioned,
        incoming: stats.incoming,
        outgoing: stats.outgoing,
        failed: stats.failed,
        connections: stats.connections,
      });
      placed.push(positioned);
      extraY += card.h + 18;
    }
    if (placed.length > 0) {
      const minX = Math.min(...placed.map((node) => node.x));
      const maxX = Math.max(...placed.map((node) => node.x + node.w));
      const maxY = Math.max(...placed.map((node) => node.y + node.h));
      groups.push({
        systemId: group.key,
        name: group.name,
        color: group.color,
        tier: 'external',
        x: minX - 12,
        y: startY - 30,
        w: maxX - minX + 24,
        h: maxY - (startY - 30) + 16,
        count: placed.length,
        labelX: minX,
        labelY: startY - 12,
      });
      maxBottom = Math.max(maxBottom, maxY);
    }
    extraY += 18;
  }
  if (extraCount > 0) {
    columns.push({
      id: 'sys-col-extra',
      key: 'external',
      title: '外部依赖 / 其他',
      en: 'EXTERNAL',
      hint: '外部服务与未归属节点',
      accent: EXTERNAL_COLOR,
      x: extraX - 12,
      y: 12,
      w: 232,
      h: 0,
      count: extraCount,
      subLabel: '外部与未归属',
    });
  }
  const worldWidth = Math.max(
    720,
    (extraCount > 0 ? extraX + cardW : padX + maxCols * colWidth + Math.max(0, maxCols - 1) * colGap) + padX,
  );
  const worldHeight = Math.max(400, maxBottom + 34);
  const finalColumns = columns.map((column) => {
    let bottom = 0;
    for (const node of nodeById.values()) {
      if (node.x + node.w < column.x || node.x > column.x + column.w) continue;
      bottom = Math.max(bottom, node.y + node.h);
    }
    return { ...column, h: Math.max(170, Math.min(worldHeight - 24, (bottom > 0 ? bottom : maxBottom) + 18)) };
  });

  const routed = routeEdges(view, nodeById, true);
  const labels: RoutedLabel[] = [];
  const nodeRects = [...nodeById.values()].map((node) => ({ x: node.x - 4, y: node.y - 4, w: node.w + 8, h: node.h + 8 }));
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (const edge of [...routed].sort((a, b) => a.rank - b.rank).slice(0, 16)) {
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
        if (labels.some((label) => overlaps(rect, { x: label.x - w / 2, y: label.y - h / 2, w: label.w, h: label.h }))) continue;
        labels.push({ edgeId: edge.edge.id, x: point.x, y: point.y + offset, w, h, text });
        placed = true;
        break;
      }
      if (placed) break;
    }
  }
  const systemLegend = graph.systems
    .map((system, index) => {
      const nodes = [...nodeById.values()].filter((node) => node.systemId === system.id);
      return {
        id: system.id,
        name: system.name,
        color: systemColors[index % systemColors.length] ?? SYSTEM_COLORS[0]!,
        nodeCount: nodes.reduce((sum, node) => sum + node.hostCount, 0),
        connections: nodes.reduce((sum, node) => sum + node.connections, 0) / 2,
      };
    })
    .filter((system) => system.nodeCount > 0);

  return {
    mode: 'system',
    width: worldWidth,
    height: worldHeight,
    headerHeight: headerH,
    nodes: [...nodeById.values()],
    nodeById,
    edges: routed.sort((a, b) => a.rank - b.rank),
    edgeById: new Map(routed.map((edge) => [edge.edge.id, edge])),
    labels,
    columns: finalColumns,
    lanes: [],
    cells: [],
    groups,
    systemLegend,
    maxEdgeCount: Math.max(1, ...view.edges.map((edge) => edge.count)),
    totalConnections: view.edges.reduce((sum, edge) => sum + edge.count, 0),
    failedConnections: view.edges.reduce((sum, edge) => sum + edge.failed, 0),
    anomalies: routed.filter((edge) => edge.anomalous).length,
  };
}

// ---------------------------------------------------------------------------
// 连线
// ---------------------------------------------------------------------------

function routeEdges(
  view: ViewGraph,
  nodeById: ReadonlyMap<string, PositionedNode>,
  systemMode: boolean,
): RoutedEdge[] {
  const sorted = [...view.edges].sort((a, b) => b.count - a.count);
  const rankById = new Map(sorted.map((edge, index) => [edge.id, index]));
  const maxEdgeCount = Math.max(1, ...view.edges.map((edge) => edge.count));
  const pairCounts = new Map<string, number>();
  for (const edge of view.edges) {
    const key = `${edge.source}->${edge.target}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const pairIndex = new Map<string, number>();
  const routed: RoutedEdge[] = [];
  for (const edge of view.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const key = `${edge.source}->${edge.target}`;
    const index = pairIndex.get(key) ?? 0;
    pairIndex.set(key, index + 1);
    const stagger = (index - ((pairCounts.get(key) ?? 1) - 1) / 2) * 10;
    const forward = target.x > source.x + 20;
    const backward = target.x + target.w < source.x - 20;
    let d: string;
    let ax: number;
    let ay: number;
    let bx: number;
    let by: number;
    let mx: number;
    let my: number;
    if (forward) {
      ax = source.x + source.w;
      ay = source.y + source.h / 2 + stagger * 0.3;
      bx = target.x - 3;
      by = target.y + target.h / 2 + stagger * 0.3;
      const dx = Math.max(36, (bx - ax) * 0.44);
      const c1x = ax + dx;
      const c1y = ay + stagger;
      const c2x = bx - dx;
      const c2y = by + stagger * 0.6;
      d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
      mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
      my = (ay + 3 * c1y + 3 * c2y + by) / 8;
    } else if (backward) {
      ax = source.x;
      ay = source.y + source.h / 2 + stagger * 0.4;
      bx = target.x + target.w + 3;
      by = target.y + target.h / 2 + stagger * 0.4;
      const bow = 58 + index * 12;
      const c1x = ax - 46;
      const c1y = ay + bow;
      const c2x = bx + 46;
      const c2y = by + bow;
      d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
      mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
      my = (ay + 3 * c1y + 3 * c2y + by) / 8;
    } else {
      ax = source.x + source.w;
      ay = source.y + source.h / 2 + stagger;
      bx = target.x + target.w;
      by = target.y + target.h / 2 + stagger;
      const bow = 40 + index * 10;
      const c1x = ax + bow;
      const c2x = bx + bow;
      d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${ay.toFixed(1)}, ${c2x.toFixed(1)} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
      mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
      my = (ay + 3 * ay + 3 * by + by) / 8;
    }
    const sourceService =
      edge.processes?.[0] ??
      source.node.services[0]?.name ??
      source.node.product ??
      source.node.hostname ??
      source.node.label;
    const targetByName = target.node.services.find((service) => service.port === edge.port);
    const targetService = targetByName?.name ?? target.node.product ?? target.node.hostname ?? target.node.label;
    const systemA = systemMode ? source.node.appSystemId ?? null : source.systemId;
    const systemB = systemMode ? target.node.appSystemId ?? null : target.systemId;
    const crossSystem = systemA !== systemB;
    const fullLabel = systemMode
      ? `${edge.count.toLocaleString('zh-CN')} 次 · ${source.node.label} → ${target.node.label}`
      : `${sourceService} → ${targetService}:${edge.port} · ${edge.count.toLocaleString('zh-CN')} 连接`;
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
      ratio: Math.min(1, edge.count / maxEdgeCount),
      failureRate: failureRateOf(edge),
      anomalous: isAnomalousEdge(edge),
      crossSystem,
      external: isExternalNode(target.node),
      systemEdge: systemMode,
      rank: rankById.get(edge.id) ?? 999,
    });
  }
  return routed;
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

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  readonly compactCards?: boolean;
}

export function computeLayout(view: ViewGraph, options: LayoutOptions = {}): TopoLayout {
  return view.mode === 'system'
    ? computeSystemLayout(view)
    : computeHostLayout(view, options.compactCards !== false);
}

/** 按主机名 / IP / 服务端口 / 业务系统 / 组件名过滤节点。 */
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
      node.node.product ?? '',
      node.node.role ?? '',
      ...node.node.services.map((service) => `${service.name}:${service.port}`),
      ...(node.node.anomalies ?? []),
    ]
      .join(' ')
      .toLowerCase();
    if (haystack.includes(query)) matches.add(node.id);
  }
  return matches;
}

export { compactNumber };


export interface EdgeGeometry {
  readonly d: string;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly mx: number;
  readonly my: number;
}

/** 拖动节点时实时重算边路径，锚点规则与自动布局保持一致。 */
export function edgeGeometry(
  source: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  target: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  stagger = 0,
  index = 0,
): EdgeGeometry {
  const forward = target.x > source.x + 20;
  const backward = target.x + target.w < source.x - 20;
  let ax: number;
  let ay: number;
  let bx: number;
  let by: number;
  let mx: number;
  let my: number;
  let d: string;
  if (forward) {
    ax = source.x + source.w;
    ay = source.y + source.h / 2 + stagger * 0.3;
    bx = target.x - 3;
    by = target.y + target.h / 2 + stagger * 0.3;
    const dx = Math.max(36, (bx - ax) * 0.44);
    const c1x = ax + dx;
    const c1y = ay + stagger;
    const c2x = bx - dx;
    const c2y = by + stagger * 0.6;
    d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
    mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
    my = (ay + 3 * c1y + 3 * c2y + by) / 8;
  } else if (backward) {
    ax = source.x;
    ay = source.y + source.h / 2 + stagger * 0.4;
    bx = target.x + target.w + 3;
    by = target.y + target.h / 2 + stagger * 0.4;
    const bow = 58 + index * 12;
    const c1x = ax - 46;
    const c1y = ay + bow;
    const c2x = bx + 46;
    const c2y = by + bow;
    d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
    mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
    my = (ay + 3 * c1y + 3 * c2y + by) / 8;
  } else {
    ax = source.x + source.w;
    ay = source.y + source.h / 2 + stagger;
    bx = target.x + target.w;
    by = target.y + target.h / 2 + stagger;
    const bow = 40 + index * 10;
    const c1x = ax + bow;
    const c2x = bx + bow;
    d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${ay.toFixed(1)}, ${c2x.toFixed(1)} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
    mx = (ax + 3 * c1x + 3 * c2x + bx) / 8;
    my = (ay + 3 * ay + 3 * by + by) / 8;
  }
  return { d, ax, ay, bx, by, mx, my };
}
