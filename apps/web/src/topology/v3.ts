/**
 * V3 拓扑可读性管线：在进入布局前把原始图整理成「看得清」的图。
 *
 * - 自环 / 管理流量 / 低流量边过滤
 * - 外部依赖按 IP 聚合、topN 折叠为「其他外部依赖」
 * - 同一 source→target 的多端口边合并成一条
 * - 提供详情面板需要的「关联节点 / 服务分类 / 外部目标」派生数据
 */
import type {
  TopologyEdge,
  TopologyGraph,
  TopologyNode,
  TopologyServicePort,
} from '@opsagent/contracts';

export interface TopologyDisplaySettings {
  readonly edgeLabels: boolean;
  readonly management: boolean;
  readonly showAllEdges: boolean;
  readonly externalTopN: number;
  readonly compactCards: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: TopologyDisplaySettings = {
  edgeLabels: false,
  management: false,
  showAllEdges: false,
  externalTopN: 8,
  compactCards: true,
};

const STORAGE_KEY = 'opsagent.topology.settings.v3';

export function loadDisplaySettings(): TopologyDisplaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DISPLAY_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<TopologyDisplaySettings>;
    return {
      edgeLabels: parsed.edgeLabels === true,
      management: parsed.management === true,
      showAllEdges: parsed.showAllEdges === true,
      externalTopN: typeof parsed.externalTopN === 'number' ? parsed.externalTopN : 8,
      compactCards: parsed.compactCards !== false,
    };
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

export function saveDisplaySettings(settings: TopologyDisplaySettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 本地存储不可用时忽略，不影响页面。
  }
}

/** 管理 / 运维端口：默认不画，避免 SSH、监控采集淹没业务访问关系。 */
export const MANAGEMENT_PORTS: ReadonlySet<number> = new Set([22, 10050, 10051, 9100, 9090, 3000]);

const MANAGEMENT_NAME = /sshd|zabbix|node_exporter|prometheus|grafana|opsagent|agent\b|control-plane|控制面/i;

export function isManagementService(service: TopologyServicePort): boolean {
  if (MANAGEMENT_PORTS.has(service.port)) return true;
  return MANAGEMENT_NAME.test(service.name) || MANAGEMENT_NAME.test(service.process ?? '');
}

export function isManagementEdge(edge: TopologyEdge, nodeById: ReadonlyMap<string, TopologyNode>): boolean {
  if (MANAGEMENT_PORTS.has(edge.port)) return true;
  const processes = edge.processes ?? [];
  if (processes.some((process) => MANAGEMENT_NAME.test(process))) return true;
  const target = nodeById.get(edge.target);
  if (edge.port === 8080) {
    const targetText = `${target?.product ?? ''} ${target?.role ?? ''} ${target?.label ?? ''}`;
    if (/control|opsagent|agent|控制面/i.test(targetText)) return true;
    if (processes.some((process) => /opsagent|agent/i.test(process))) return true;
  }
  return false;
}

export interface ExternalTarget {
  readonly ip: string;
  readonly hostname?: string;
  readonly ports: readonly {
    readonly port: number;
    readonly protocol: string;
    readonly count: number;
    readonly failed: number;
  }[];
  readonly connections: number;
  readonly failed: number;
}

export interface ExternalGroupInfo {
  readonly nodeId: string;
  readonly ip: string;
  readonly targets: readonly ExternalTarget[];
  readonly isAggregate: boolean;
}

export interface PreparedStats {
  readonly hostCount: number;
  readonly externalIpCount: number;
  readonly externalCardCount: number;
  readonly edgeCount: number;
  readonly originalEdgeCount: number;
  readonly hiddenLowTraffic: number;
  readonly hiddenManagement: number;
  readonly hiddenSelfLoops: number;
  readonly totalConnections: number;
  readonly failedConnections: number;
  readonly unassignedHidden: number;
}

export interface PreparedTopology {
  readonly graph: TopologyGraph;
  readonly stats: PreparedStats;
  readonly externalGroups: ReadonlyMap<string, ExternalGroupInfo>;
}

interface AggregateExternal {
  readonly ip: string;
  readonly hostname?: string;
  readonly nodeIds: string[];
  readonly ports: { port: number; protocol: string; count: number; failed: number }[];
  connections: number;
  failed: number;
  services: TopologyServicePort[];
  anomalies: string[];
  lastSeen?: string;
}

function externalIpOf(node: TopologyNode): string {
  return node.ip?.trim() || node.hostname?.trim() || node.label;
}

function aggregateExternal(node: TopologyNode, state: AggregateExternal): void {
  state.nodeIds.push(node.id);
  for (const service of node.services) {
    if (!state.services.some((item) => item.port === service.port && item.name === service.name)) {
      state.services.push(service);
    }
  }
  for (const anomaly of node.anomalies ?? []) {
    if (!state.anomalies.includes(anomaly)) state.anomalies.push(anomaly);
  }
}

function makeExternalNode(
  id: string,
  label: string,
  state: AggregateExternal,
  options: { isAggregate: boolean; totalIps?: number },
): TopologyNode {
  return {
    id,
    label,
    kind: 'external',
    tier: 'external',
    status: state.failed > 0 ? 'online' : 'unknown',
    services: state.services.slice(0, 40),
    metrics: {
      active: state.connections,
      opened: state.connections,
      closed: 0,
      failed: state.failed,
      inbound: state.connections,
      outbound: state.connections,
    },
    product: options.isAggregate ? '外部依赖' : '外部服务',
    role: options.isAggregate
      ? `${options.totalIps ?? state.nodeIds.length} 个 IP · ${state.services.length} 个端口`
      : `${state.services.length} 个端口`,
    inferred: true,
    note: options.isAggregate
      ? `连接数较低的 ${options.totalIps ?? state.nodeIds.length} 个外部 IP 合并展示，点击查看全部目标。`
      : `外部 IP ${state.ip}，同 IP 的多个端口已合并。`,
  };
}

function buildMergedLabel(
  source: TopologyNode | undefined,
  target: TopologyNode | undefined,
  ports: readonly number[],
  count: number,
): string {
  const sourceName =
    source?.product ?? source?.label ?? source?.hostname ?? 'source';
  const targetName = target?.product ?? target?.label ?? target?.hostname ?? 'target';
  const portText = ports.length > 0 ? ports.slice(0, 4).join('/') : '—';
  const suffix = ports.length > 4 ? ` +${ports.length - 4}` : '';
  return `${sourceName} → ${targetName} :${portText}${suffix} · ${count.toLocaleString('zh-CN')} 连接`;
}

export function prepareTopology(
  graph: TopologyGraph,
  settings: TopologyDisplaySettings,
  includeUnassigned: boolean,
): PreparedTopology {
  const unassignedSystemIds = new Set(
    graph.systems
      .filter((system) => /未归属|未分配|未分类|未知|unassigned|unknown/i.test(system.name.trim()))
      .map((system) => system.id),
  );
  const isUnassignedHost = (node: TopologyNode): boolean => {
    if (node.kind === 'external' || node.tier === 'external' || node.inferred === true) return false;
    if (node.appSystemId === null || node.appSystemId === undefined) return true;
    return unassignedSystemIds.has(node.appSystemId);
  };
  const isExternal = (node: TopologyNode): boolean =>
    node.kind === 'external' || node.tier === 'external' || node.inferred === true;

  let unassignedHidden = 0;
  const keptNodes = graph.nodes.filter((node) => {
    if (isExternal(node)) return true;
    if (includeUnassigned) return true;
    if (isUnassignedHost(node)) {
      unassignedHidden += 1;
      return false;
    }
    return true;
  });
  const keptIds = new Set(keptNodes.map((node) => node.id));
  const nodeById = new Map(keptNodes.map((node) => [node.id, node]));

  let hiddenManagement = 0;
  let hiddenSelfLoops = 0;
  const baseEdges: TopologyEdge[] = [];
  for (const edge of graph.edges) {
    if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue;
    if (edge.source === edge.target) {
      hiddenSelfLoops += 1;
      continue;
    }
    if (!settings.management && isManagementEdge(edge, nodeById)) {
      hiddenManagement += 1;
      continue;
    }
    baseEdges.push(edge);
  }

  // ---- 外部依赖：按 IP 聚合 + topN ----
  const externalNodes = keptNodes.filter(isExternal);
  const internalNodes = keptNodes.filter((node) => !isExternal(node));
  const groups = new Map<string, AggregateExternal>();
  const externalNodeToIp = new Map<string, string>();
  for (const node of externalNodes) {
    const ip = externalIpOf(node);
    const state =
      groups.get(ip) ??
      ({
        ip,
        ...(node.hostname ? { hostname: node.hostname } : {}),
        nodeIds: [],
        ports: [],
        connections: 0,
        failed: 0,
        services: [],
        anomalies: [],
      } satisfies AggregateExternal);
    externalNodeToIp.set(node.id, ip);
    aggregateExternal(node, state);
    groups.set(ip, state);
  }

  const mappedEdges = baseEdges.map((edge) => {
    const sourceIp = externalNodeToIp.get(edge.source);
    const targetIp = externalNodeToIp.get(edge.target);
    const source = sourceIp ? `ext:${sourceIp}` : edge.source;
    const target = targetIp ? `ext:${targetIp}` : edge.target;
    return { ...edge, source, target, __externalIp: targetIp ?? sourceIp };
  });
  // 把边上的连接数汇总到外部 IP，供排序 / topN 使用。
  for (const edge of mappedEdges) {
    const ip = (edge as TopologyEdge & { __externalIp?: string }).__externalIp;
    if (!ip) continue;
    const state = groups.get(ip);
    if (!state) continue;
    state.connections += edge.count;
    state.failed += edge.failed;
    const targetPorts = state.ports.find((item) => item.port === edge.port);
    if (targetPorts) {
      targetPorts.count += edge.count;
      targetPorts.failed += edge.failed;
    } else {
      state.ports.push({ port: edge.port, protocol: edge.protocol, count: edge.count, failed: edge.failed });
    }
    if (edge.lastSeen && (!state.lastSeen || edge.lastSeen > state.lastSeen)) state.lastSeen = edge.lastSeen;
  }

  const rankedExternal = [...groups.values()].sort((a, b) => b.connections - a.connections);
  const topN = Math.max(1, Math.min(50, settings.externalTopN));
  const keptExternal = rankedExternal.slice(0, topN);
  const collapsedExternal = rankedExternal.slice(topN);

  const syntheticExternalNodes: TopologyNode[] = keptExternal.map((state) => {
    const node = makeExternalNode(`ext:${state.ip}`, state.hostname ?? state.ip, state, { isAggregate: false });
    return {
      ...node,
      ...(state.lastSeen ? { note: `${node.note ?? ''} 最近观测 ${state.lastSeen}` } : {}),
    };
  });
  let otherExternalNode: TopologyNode | null = null;
  if (collapsedExternal.length > 0) {
    const merged: AggregateExternal = {
      ip: '—',
      nodeIds: [],
      ports: [],
      connections: 0,
      failed: 0,
      services: [],
      anomalies: [],
    };
    for (const state of collapsedExternal) {
      merged.nodeIds.push(...state.nodeIds);
      merged.connections += state.connections;
      merged.failed += state.failed;
      for (const service of state.services) {
        if (!merged.services.some((item) => item.port === service.port && item.name === service.name)) {
          merged.services.push(service);
        }
      }
      for (const port of state.ports) {
        const existing = merged.ports.find((item) => item.port === port.port);
        if (existing) {
          existing.count += port.count;
          existing.failed += port.failed;
        } else {
          merged.ports.push({ ...port });
        }
      }
    }
    otherExternalNode = makeExternalNode('ext:other', '其他外部依赖', merged, {
      isAggregate: true,
      totalIps: collapsedExternal.length,
    });
  }
  const externalRemap = new Map<string, string>();
  for (const state of keptExternal) {
    for (const nodeId of state.nodeIds) externalRemap.set(nodeId, `ext:${state.ip}`);
  }
  for (const state of collapsedExternal) {
    for (const nodeId of state.nodeIds) externalRemap.set(nodeId, 'ext:other');
  }

  // ---- 边重定向 + 同 source-target 合并 ----
  let hiddenLowTraffic = 0;
  const mergedMap = new Map<string, TopologyEdge & { ports: number[] }>();
  for (const edge of mappedEdges) {
    const source = externalRemap.get(edge.source) ?? edge.source;
    const target = externalRemap.get(edge.target) ?? edge.target;
    if (source === target) {
      hiddenSelfLoops += 1;
      continue;
    }
    const key = `${source}->${target}`;
    const existing = mergedMap.get(key);
    if (!existing) {
      mergedMap.set(key, {
        id: `e:${source}->${target}`,
        source,
        target,
        protocol: edge.protocol,
        port: edge.port,
        count: edge.count,
        opened: edge.opened,
        failed: edge.failed,
        confidence: edge.confidence,
        countBasis: edge.countBasis ?? 'observed',
        ...(edge.processes ? { processes: edge.processes } : {}),
        ...(edge.external ? { external: true } : {}),
        ports: [edge.port],
      });
    } else {
      const ports = existing.ports.includes(edge.port) ? existing.ports : [...existing.ports, edge.port];
      mergedMap.set(key, {
        ...existing,
        count: existing.count + edge.count,
        opened: existing.opened + edge.opened,
        failed: existing.failed + edge.failed,
        confidence: Math.min(existing.confidence, edge.confidence),
        processes: [...new Set([...(existing.processes ?? []), ...(edge.processes ?? [])])],
        ports,
        protocol: existing.protocol === edge.protocol ? existing.protocol : 'mixed',
        ...(existing.external || edge.external ? { external: true } : {}),
      });
    }
  }

  const allNodes = new Map(internalNodes.map((node) => [node.id, node]));
  for (const node of syntheticExternalNodes) allNodes.set(node.id, node);
  if (otherExternalNode) allNodes.set(otherExternalNode.id, otherExternalNode);

  let mergedEdges: TopologyEdge[] = [...mergedMap.values()].map((edge) => {
    const source = allNodes.get(edge.source);
    const target = allNodes.get(edge.target);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      protocol: edge.protocol,
      port: edge.ports[0] ?? edge.port,
      count: edge.count,
      opened: edge.opened,
      failed: edge.failed,
      confidence: edge.confidence,
      ...(edge.countBasis ? { countBasis: edge.countBasis } : {}),
      ...(edge.processes ? { processes: edge.processes } : {}),
      ...(edge.external ? { external: true } : {}),
      label: buildMergedLabel(source, target, edge.ports, edge.count),
    };
  });

  const totalConnectionsAll = mergedEdges.reduce((sum, edge) => sum + edge.count, 0);
  if (!settings.showAllEdges) {
    const sorted = [...mergedEdges].sort((a, b) => b.count - a.count);
    const maxCount = sorted[0]?.count ?? 0;
    // 占比阈值 + 最大流量 8% 下限：即使是小图，也隐藏最尾部的一两条边，开关可恢复。
    const threshold = Math.max(2, totalConnectionsAll * 0.004, maxCount * 0.08);
    const keep = new Set<string>();
    sorted.forEach((edge, index) => {
      if (index < 28 || edge.count >= threshold) keep.add(edge.id);
    });
    hiddenLowTraffic = mergedEdges.length - keep.size;
    mergedEdges = mergedEdges.filter((edge) => keep.has(edge.id));
  }

  // ---- 外部目标明细（供详情面板） ----
  const externalGroups = new Map<string, ExternalGroupInfo>();
  for (const state of keptExternal) {
    externalGroups.set(`ext:${state.ip}`, {
      nodeId: `ext:${state.ip}`,
      ip: state.ip,
      isAggregate: false,
      targets: [
        {
          ip: state.ip,
          ...(state.hostname ? { hostname: state.hostname } : {}),
          connections: state.connections,
          failed: state.failed,
          ports: state.ports,
        },
      ],
    });
  }
  if (otherExternalNode) {
    externalGroups.set('ext:other', {
      nodeId: 'ext:other',
      ip: '—',
      isAggregate: true,
      targets: collapsedExternal.map((state) => ({
        ip: state.ip,
        ...(state.hostname ? { hostname: state.hostname } : {}),
        connections: state.connections,
        failed: state.failed,
        ports: state.ports,
      })),
    });
  }

  const hostCount = internalNodes.filter((node) => !isUnassignedHost(node)).length;
  const preparedStats: PreparedStats = {
    hostCount,
    externalIpCount: rankedExternal.length,
    externalCardCount: keptExternal.length + (otherExternalNode ? 1 : 0),
    edgeCount: mergedEdges.length,
    originalEdgeCount: graph.edges.length,
    hiddenLowTraffic,
    hiddenManagement,
    hiddenSelfLoops,
    totalConnections: mergedEdges.reduce((sum, edge) => sum + edge.count, 0),
    failedConnections: mergedEdges.reduce((sum, edge) => sum + edge.failed, 0),
    unassignedHidden,
  };

  const preparedGraph: TopologyGraph = {
    ...graph,
    nodes: [...allNodes.values()],
    edges: mergedEdges,
    stats: {
      ...graph.stats,
      nodeCount: allNodes.size,
      edgeCount: mergedEdges.length,
      hostCount: preparedStats.hostCount,
      externalCount: preparedStats.externalIpCount,
      totalConnections: preparedStats.totalConnections,
      failedConnections: preparedStats.failedConnections,
      excludedUnassigned: graph.stats.excludedUnassigned ?? preparedStats.unassignedHidden,
    },
  };
  return { graph: preparedGraph, stats: preparedStats, externalGroups };
}

export interface RelatedNode {
  readonly nodeId: string;
  readonly label: string;
  readonly role: string;
  readonly ports: readonly number[];
  readonly connections: number;
  readonly failed: number;
}

export function buildRelatedNodes(
  edges: readonly TopologyEdge[],
  nodes: readonly TopologyNode[],
  nodeId: string,
): { outgoing: RelatedNode[]; incoming: RelatedNode[] } {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const collect = (direction: 'out' | 'in'): RelatedNode[] => {
    const map = new Map<string, { ports: Set<number>; connections: number; failed: number }>();
    for (const edge of edges) {
      const peerId = direction === 'out' ? edge.target : edge.source;
      const ownId = direction === 'out' ? edge.source : edge.target;
      if (ownId !== nodeId) continue;
      const entry = map.get(peerId) ?? { ports: new Set<number>(), connections: 0, failed: 0 };
      entry.ports.add(edge.port);
      entry.connections += edge.count;
      entry.failed += edge.failed;
      map.set(peerId, entry);
    }
    return [...map.entries()]
      .map(([peerId, value]) => {
        const peer = nodeById.get(peerId);
        return {
          nodeId: peerId,
          label: peer?.label ?? peerId,
          role: peer?.product ?? peer?.role ?? '外部节点',
          ports: [...value.ports].sort((a, b) => a - b),
          connections: value.connections,
          failed: value.failed,
        } satisfies RelatedNode;
      })
      .sort((a, b) => b.connections - a.connections);
  };
  return { outgoing: collect('out'), incoming: collect('in') };
}

export function splitServices(
  services: readonly TopologyServicePort[],
): { business: TopologyServicePort[]; management: TopologyServicePort[] } {
  const business: TopologyServicePort[] = [];
  const management: TopologyServicePort[] = [];
  for (const service of services) {
    if (isManagementService(service)) management.push(service);
    else business.push(service);
  }
  return { business, management };
}
