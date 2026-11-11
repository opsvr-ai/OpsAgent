import type { Pool } from 'pg';
import type {
  TopologyAnalysis,
  TopologyAnalysisTrace,
  TopologyDraft,
  TopologyDraftEdge,
  TopologyEdge,
  TopologyGraph,
  TopologyGraphStats,
  TopologyGraphSummary,
  TopologyHotPath,
  TopologyInsight,
  TopologyLearningEdge,
  TopologyLearningHost,
  TopologyLearningInput,
  TopologyLearningPolicy,
  TopologyLearningProgress,
  TopologyLearningSession,
  TopologyLearningStatus,
  TopologyNode,
  TopologyNodeKind,
  TopologyNodeMetrics,
  TopologyNodeStatus,
  TopologyProcessInfo,
  TopologyScope,
  TopologyServicePort,
  TopologySystemGroup,
  TopologyTier,
  TopologyWindow,
} from '@opsagent/contracts';
import { ModelCompletionService } from '../models/completion.js';
import { ModelProviderService } from '../models/service.js';
import { AgentConnectionEdgeService } from './connection_edges.js';
import {
  TopologyEdgeTagService,
  attachEdgeTags,
  backfillGraphRelationKeys,
  topologyNodeRelationName,
  topologyRelationKey,
} from './topology_tags.js';
import { TopologyAnalyzer } from './topology_analyzer.js';
import type { TopologyAnalysisResult } from './topology_analyzer.js';

/**
 * 固定时间窗建连采集 → 服务端聚合 → 大模型分析 → 业务访问拓扑图。
 *
 * 状态机：collecting → aggregating → analyzing → ready | failed；cancelled 可由用户中止。
 * 聚合逻辑（buildLearningInput / buildGraphPayload）是纯函数，便于单测；
 * 分析器（队友 C 的 topology_analyzer.ts）通过动态 import 解耦，交付后切换静态 import。
 */

/** 学习窗口最小值（秒）。 */
export const TOPOLOGY_WINDOW_MIN_SECONDS = 60;
/** 学习窗口最大值（秒）。 */
export const TOPOLOGY_WINDOW_MAX_SECONDS = 1800;
/** 默认学习窗口（秒）。 */
export const TOPOLOGY_WINDOW_DEFAULT_SECONDS = 300;
/** 自动学习周期最小值（秒）。 */
export const TOPOLOGY_POLICY_MIN_INTERVAL_SECONDS = 600;
/** 自动学习周期最大值（秒）。 */
export const TOPOLOGY_POLICY_MAX_INTERVAL_SECONDS = 86_400;
/** analyzing 超过该时长仍未完成则判定失败。 */
export const TOPOLOGY_ANALYZING_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_AGGREGATED_EDGES = 5000;
const MAX_HOSTS = 300;
const MAX_DRAFT_NODES = 300;
const MAX_DRAFT_EDGES = 800;
const MAX_ERROR_LENGTH = 500;

// ---------------------------------------------------------------------------
// 分析器接口（./topology_analyzer.ts 由 LLM 分析器实现）
// ---------------------------------------------------------------------------

export type { TopologyAnalysisResult } from './topology_analyzer.js';

/** 分析器最小接口，便于在拓扑学习服务里注入测试桩。 */
export interface TopologyAnalyzerLike {
  analyze(
    tenantId: string,
    input: TopologyLearningInput,
    options?: { readonly modelLabel?: string },
  ): Promise<TopologyAnalysisResult>;
}

/** 会话/策略等业务错误，路由据此映射 400/404/409。 */
export class TopologyLearningError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TopologyLearningError';
  }
}

// ---------------------------------------------------------------------------
// 聚合输入（DB 行 → 纯函数）
// ---------------------------------------------------------------------------

export interface LearningAgentSource {
  readonly id: string;
  readonly hostname: string;
  readonly status: string;
  readonly systemInfo: Readonly<Record<string, unknown>>;
  readonly appSystemId: string | null;
  readonly appSystemName: string;
}

export interface LearningInventorySource {
  readonly agentId: string;
  readonly kind: string;
  readonly name: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface LearningEdgeSource {
  readonly agentId: string;
  readonly direction: string;
  readonly process: string;
  readonly pid: number;
  readonly service: string;
  readonly command: string;
  readonly localAddress: string;
  readonly localPort: number;
  readonly peerAddress: string;
  readonly peerPort: number;
  readonly protocol: string;
  readonly opened: number;
  readonly closed: number;
  readonly failed: number;
  readonly active: number;
  readonly lastSeen?: string | null;
}

export interface LearningInputSources {
  readonly scope: TopologyScope;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly agents: readonly LearningAgentSource[];
  readonly inventory: readonly LearningInventorySource[];
  readonly edges: readonly LearningEdgeSource[];
  readonly anomalies?: ReadonlyMap<string, readonly string[]>;
  /** 是否把未归属应用系统的纳管主机纳入拓扑（默认 false）。 */
  readonly includeUnassigned?: boolean;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegative(value: unknown): number {
  return Math.max(0, num(value));
}

function clamp01(value: unknown): number {
  return Math.min(Math.max(num(value), 0), 1);
}

function iso(value: Date): string {
  return value.toISOString();
}

/** IPv4/v6 文本归一化：去掉 scope id、方括号、v4-mapped 前缀。 */
export function normalizeTopologyAddress(value: string): string {
  const trimmed = value.split('%')[0]?.trim().toLowerCase() ?? '';
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return unbracketed.startsWith('::ffff:') ? unbracketed.slice(7) : unbracketed;
}

function isLoopbackAddress(value: string): boolean {
  const address = normalizeTopologyAddress(value);
  return address === ''
    || address === 'localhost'
    || address === '::1'
    || address === '::'
    || address === '0.0.0.0'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:7f');
}

/** 粗略判断公网 IPv4，用于外部依赖备注；拿不准时按内网处理。 */
function isPublicAddress(value: string): boolean {
  const address = normalizeTopologyAddress(value);
  const match = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first === 10 || first === 127 || first === 0) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 169 && second === 254) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  return true;
}

function externalPeerNote(address: string): string {
  return isPublicAddress(address) ? '公网 IP' : '未纳管';
}

function normalizeProcess(value: string): string {
  const quoted = value.match(/"([^"]+)"/)?.[1];
  const raw = (quoted ?? value).trim();
  const base = raw.split('/').pop() ?? raw;
  return base.replace(/^\[|\]$/g, '').slice(0, 80);
}

function jarService(command: string): string {
  const match = command.match(/-jar\s+([^\s]+)/);
  if (!match) return '';
  const file = (match[1] ?? '').split('/').pop() ?? '';
  return file.replace(/\.jar$/i, '').slice(0, 80);
}

function portFromAddress(name: string): number {
  const index = name.lastIndexOf(':');
  if (index < 0) return 0;
  const parsed = Number.parseInt(name.slice(index + 1), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 0;
}

function isTcpProtocol(value: string): boolean {
  const protocol = value.trim().toLowerCase();
  return protocol === '' || protocol === 'tcp' || protocol === 'tcp4' || protocol === 'tcp6';
}

/**
 * Agent 自身管理流量（心跳/命令通道）不应进入业务拓扑。
 * 只匹配 opsagent-agent 这个特定前缀/子串，避免误伤 zabbix_agent2、java agent 等业务进程。
 */
function isAgentSelfTraffic(edge: LearningEdgeSource): boolean {
  const process = edge.process.toLowerCase();
  const service = edge.service.toLowerCase();
  const command = edge.command.toLowerCase();
  if (process.includes('opsagent-agent') || service.includes('opsagent-agent') || command.includes('opsagent-agent')) {
    return true;
  }
  const normalizedService = service.trim();
  return normalizedService === 'opsagent-agent' || normalizedService.startsWith('opsagent-agent-');
}

// ---------------------------------------------------------------------------
// 纯函数：窗口样本 → TopologyLearningInput
// ---------------------------------------------------------------------------

interface PortInfo {
  readonly port: number;
  readonly service: string;
  readonly process: string;
  readonly pid: number;
}

interface MutableLearningEdge {
  readonly fromAgentId: string;
  readonly fromHost: string;
  readonly fromService: string;
  readonly fromProcess: string;
  readonly toAgentId: string | null;
  readonly toHost: string;
  readonly toIp: string;
  readonly toPort: number;
  readonly toService: string;
  opened: number;
  closed: number;
  failed: number;
  active: number;
  hasOut: boolean;
  hasIn: boolean;
  readonly protocol: string;
  lastSeen: string | undefined;
  readonly targetAppSystemId: string | null;
  readonly targetAppSystemName: string | undefined;
  readonly external: boolean;
}

function addEdgeCounts(target: MutableLearningEdge, source: LearningEdgeSource): void {
  target.opened += nonNegative(source.opened);
  target.closed += nonNegative(source.closed);
  target.failed += nonNegative(source.failed);
  target.active += nonNegative(source.active);
}

function updateLastSeen(target: MutableLearningEdge, source: LearningEdgeSource): void {
  const value = source.lastSeen;
  if (typeof value !== 'string') return;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return;
  if (target.lastSeen === undefined || parsed > Date.parse(target.lastSeen)) {
    target.lastSeen = new Date(parsed).toISOString();
  }
}

/**
 * 把窗口内的边样本聚合成学习输入。
 *
 * 规则：
 * - out：源=本机 agent，目标=peer IP 反查纳管 agent；找不到则归入外部 peer；
 * - in：目标=本机监听端口，源=peer IP 反查纳管 agent；未纳管来源直接丢弃；
 * - 同一逻辑边 (fromAgentId, fromService, toAgentId|peerIp, toPort) 合并计数；
 * - out 与 in 都观测到 → direction=both；本机回环/同机内部流量跳过。
 */
export function buildLearningInput(sources: LearningInputSources): TopologyLearningInput {
  const includeUnassigned = sources.includeUnassigned === true;
  // 默认只把已归属应用系统的主机纳入拓扑；未归属主机整体排除（含其出/入边）。
  const isEligible = (agent: LearningAgentSource): boolean => includeUnassigned || agent.appSystemId !== null;
  // 按应用系统学习时，只为该系统的主机聚合边；跨系统目标/来源主机作为
  // 「被引用主机」保留（可见跨系统访问），但其他系统的无关主机不会进入拓扑。
  const scopeAgentSystemId = sources.scope.kind === 'app-system'
    ? sources.scope.appSystemId ?? null
    : null;
  const inScope = (agent: LearningAgentSource): boolean =>
    scopeAgentSystemId === null || agent.appSystemId === scopeAgentSystemId;
  const agentsById = new Map(sources.agents.map((agent) => [agent.id, agent]));
  const byIp = new Map<string, LearningAgentSource>();
  const primaryIp = new Map<string, string>();
  for (const agent of sources.agents) {
    const info = agent.systemInfo;
    const addresses: string[] = [];
    const declared = typeof info.ip === 'string' ? normalizeTopologyAddress(info.ip) : '';
    if (declared) addresses.push(declared);
    if (Array.isArray(info.ipAddresses)) {
      for (const address of info.ipAddresses) {
        if (typeof address === 'string' && address.trim()) addresses.push(normalizeTopologyAddress(address));
      }
    }
    const primary = addresses[0] ?? '';
    if (primary) primaryIp.set(agent.id, primary);
    for (const address of addresses) {
      if (address && !byIp.has(address)) byIp.set(address, agent);
    }
  }

  // 进程表：comm → command（用于把 java -jar xxx.jar 还原成服务名），
  // 同时收集 TopologyProcessInfo 证据供模型识别中间件/数据库/应用/系统服务。
  interface RawProcessInfo {
    readonly info: TopologyProcessInfo;
    readonly hasCommand: boolean;
    readonly business: boolean;
  }
  const processesByAgent = new Map<string, Map<string, string>>();
  const rawProcessesByAgent = new Map<string, RawProcessInfo[]>();
  for (const row of sources.inventory) {
    if (row.kind !== 'process') continue;
    const name = normalizeProcess(text(row.detail.name, 120) || row.name);
    if (!name) continue;
    const command = text(row.detail.command, 300);
    const user = text(row.detail.user, 80);
    const pid = Math.max(0, Math.floor(num(row.detail.pid)));
    const commands = processesByAgent.get(row.agentId) ?? new Map<string, string>();
    commands.set(name, command);
    processesByAgent.set(row.agentId, commands);
    const classification = text(row.detail.classification, 40).toLowerCase();
    const list = rawProcessesByAgent.get(row.agentId) ?? [];
    list.push({
      info: {
        name,
        ...(command ? { command } : {}),
        ...(user ? { user } : {}),
        ...(pid > 0 ? { pid } : {}),
      },
      hasCommand: command.length > 0,
      business: classification !== 'system',
    });
    rawProcessesByAgent.set(row.agentId, list);
  }
  // 每台机最多 12 个：优先业务进程、有命令行的，再按名称稳定排序。
  const processesForAgent = (agentId: string): TopologyProcessInfo[] => {
    const list = rawProcessesByAgent.get(agentId) ?? [];
    return [...list]
      .sort((left, right) => (
        Number(right.business) - Number(left.business)
        || Number(right.hasCommand) - Number(left.hasCommand)
        || left.info.name.localeCompare(right.info.name)
        || (left.info.pid ?? 0) - (right.info.pid ?? 0)
      ))
      .slice(0, 12)
      .map((item) => item.info);
  };
  const processLabel = (agentId: string, raw: string): string => {
    const name = normalizeProcess(raw);
    if (!name) return '';
    const command = processesByAgent.get(agentId)?.get(name);
    const service = command ? jarService(command) : '';
    return service || name;
  };

  // 监听端口表：port → 服务名/进程/pid。
  const portsByAgent = new Map<string, Map<number, PortInfo>>();
  for (const row of sources.inventory) {
    if (row.kind !== 'port') continue;
    const port = portFromAddress(row.name);
    if (port === 0) continue;
    const ports = portsByAgent.get(row.agentId) ?? new Map<number, PortInfo>();
    if (ports.has(port)) continue;
    const process = text(row.detail.process, 120);
    const service = text(row.detail.service, 120) || processLabel(row.agentId, process) || `port ${port}`;
    ports.set(port, { port, service, process, pid: Math.max(0, Math.floor(num(row.detail.pid))) });
    portsByAgent.set(row.agentId, ports);
  }
  const portService = (agentId: string, port: number): PortInfo | undefined => portsByAgent.get(agentId)?.get(port);
  const servicesForAgent = (agentId: string): TopologyServicePort[] => {
    const ports = portsByAgent.get(agentId);
    if (!ports) return [];
    const seen = new Set<string>();
    const services: TopologyServicePort[] = [];
    for (const [port, info] of ports) {
      const key = `${info.service}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      services.push({
        name: info.service,
        port,
        ...(info.process ? { process: info.process } : {}),
        ...(info.pid > 0 ? { pid: info.pid } : {}),
      });
    }
    return services.sort((a, b) => a.port - b.port).slice(0, 20);
  };

  const merged = new Map<string, MutableLearningEdge>();
  // 同一 (源 agent, 目标 agent, 目标端口) 可能有多个服务（进程）的 out 边，必须按服务分开存。
  const outByPeerPort = new Map<string, MutableLearningEdge[]>();
  const externalPeers = new Map<string, {
    ip: string;
    port: number;
    processes: Set<string>;
    opened: number;
    failed: number;
  }>();

  const logicalKey = (edge: MutableLearningEdge): string => [
    edge.fromAgentId,
    edge.fromService,
    edge.toAgentId ?? `ip:${edge.toIp}`,
    edge.toPort,
  ].join('|');

  const upsert = (prototype: MutableLearningEdge, source: LearningEdgeSource): MutableLearningEdge => {
    const key = logicalKey(prototype);
    const existing = merged.get(key);
    const target = existing ?? prototype;
    addEdgeCounts(target, source);
    updateLastSeen(target, source);
    if (existing) {
      existing.hasOut = existing.hasOut || prototype.hasOut;
      existing.hasIn = existing.hasIn || prototype.hasIn;
    } else {
      merged.set(key, target);
    }
    return target;
  };

  // 先聚合 out 边（带本机服务名与目标端口），再处理 in 边。
  // 否则 in 先到时只能把 fromService 记为 unknown，会与 out 边拆成两条逻辑边。
  const orderedEdges = [...sources.edges].sort((left, right) => {
    const leftWeight = left.direction === 'out' ? 0 : 1;
    const rightWeight = right.direction === 'out' ? 0 : 1;
    return leftWeight - rightWeight;
  });
  for (const edge of orderedEdges) {
    const localAgent = agentsById.get(edge.agentId);
    if (!localAgent) continue;
    if (!isEligible(localAgent)) continue;
    // 范围过滤：非本应用系统主机的边不参与聚合，避免切到某个系统后仍出现
    // 其他系统的完整内部拓扑；跨系统目标主机由本系统主机的边引用进来。
    if (!inScope(localAgent)) continue;
    if (!isTcpProtocol(edge.protocol)) continue;
    if (edge.direction !== 'out' && edge.direction !== 'in') continue;
    // 排除 Agent 自身到控制面的管理连接（心跳/命令通道）。
    if (isAgentSelfTraffic(edge)) continue;
    const peerIp = normalizeTopologyAddress(edge.peerAddress);
    if (!peerIp || isLoopbackAddress(peerIp)) continue;
    const peerPort = Math.min(Math.max(Math.floor(num(edge.peerPort)), 0), 65535);

    if (edge.direction === 'out') {
      if (peerPort === 0) continue;
      const target = byIp.get(peerIp);
      // 对端是纳管主机但未归属应用系统时，整条边丢弃（不降级成外部依赖）。
      if (target && !isEligible(target)) continue;
      if (target && target.id === localAgent.id) continue;
      const fromService = text(
        edge.service || jarService(edge.command) || processLabel(localAgent.id, edge.process)
          || normalizeProcess(edge.process) || 'unknown',
        120,
      ) || 'unknown';
      const fromProcess = (normalizeProcess(edge.process) || fromService).slice(0, 120);
      const prototype: MutableLearningEdge = target
        ? {
            fromAgentId: localAgent.id,
            fromHost: localAgent.hostname,
            fromService,
            fromProcess,
            toAgentId: target.id,
            toHost: target.hostname,
            toIp: primaryIp.get(target.id) ?? peerIp,
            toPort: peerPort,
            toService: portService(target.id, peerPort)?.service ?? `port ${peerPort}`,
            opened: 0,
            closed: 0,
            failed: 0,
            active: 0,
            hasOut: true,
            hasIn: false,
            protocol: 'tcp',
            lastSeen: undefined,
            targetAppSystemId: target.appSystemId,
            targetAppSystemName: target.appSystemName || undefined,
            external: false,
          }
        : {
            fromAgentId: localAgent.id,
            fromHost: localAgent.hostname,
            fromService,
            fromProcess,
            toAgentId: null,
            toHost: peerIp,
            toIp: peerIp,
            toPort: peerPort,
            toService: `port ${peerPort}`,
            opened: 0,
            closed: 0,
            failed: 0,
            active: 0,
            hasOut: true,
            hasIn: false,
            protocol: 'tcp',
            lastSeen: undefined,
            targetAppSystemId: null,
            targetAppSystemName: undefined,
            external: true,
          };
      const mergedEdge = upsert(prototype, edge);
      if (target) {
        const key = `${localAgent.id}|${target.id}|${peerPort}`;
        const list = outByPeerPort.get(key) ?? [];
        if (!list.includes(mergedEdge)) list.push(mergedEdge);
        outByPeerPort.set(key, list);
      }
      if (!target) {
        const key = `${peerIp}|${peerPort}`;
        const peer = externalPeers.get(key) ?? {
          ip: peerIp,
          port: peerPort,
          processes: new Set<string>(),
          opened: 0,
          failed: 0,
        };
        if (fromProcess) peer.processes.add(fromProcess);
        peer.opened += nonNegative(edge.opened);
        peer.failed += nonNegative(edge.failed);
        externalPeers.set(key, peer);
      }
      continue;
    }

    // direction = in：对端必须是纳管主机，否则不把未纳管客户端当成拓扑节点。
    const localPort = Math.min(Math.max(Math.floor(num(edge.localPort)), 0), 65535);
    if (localPort === 0) continue;
    const sourceAgent = byIp.get(peerIp);
    if (!sourceAgent || sourceAgent.id === localAgent.id) continue;
    if (!isEligible(sourceAgent)) continue;
    // 计数口径以 out 样本为准；in 样本只补 direction=both，避免同一条边双端重复累加。
    // in 样本不携带客户端源端口，源主机访问同一目标端口有多个服务时无法精确区分，
    // 这里把该 (源, 目标, 端口) 下的所有 out 逻辑边都标记为双向（不改变计数）。
    const candidates = outByPeerPort.get(`${sourceAgent.id}|${localAgent.id}|${localPort}`) ?? [];
    if (candidates.length > 0) {
      for (const candidate of candidates) {
        candidate.hasIn = true;
        updateLastSeen(candidate, edge);
      }
      continue;
    }
    const prototype: MutableLearningEdge = {
      fromAgentId: sourceAgent.id,
      fromHost: sourceAgent.hostname,
      fromService: 'unknown',
      fromProcess: 'unknown',
      toAgentId: localAgent.id,
      toHost: localAgent.hostname,
      toIp: primaryIp.get(localAgent.id) ?? '',
      toPort: localPort,
      toService: portService(localAgent.id, localPort)?.service ?? `port ${localPort}`,
      opened: 0,
      closed: 0,
      failed: 0,
      active: 0,
      hasOut: false,
      hasIn: true,
      protocol: 'tcp',
      lastSeen: undefined,
      targetAppSystemId: localAgent.appSystemId,
      targetAppSystemName: localAgent.appSystemName || undefined,
      external: false,
    };
    upsert(prototype, edge);
  }

  // 参与拓扑的主机：scope 内主机 + 边引用到的对端主机（跨系统访问的目标也要有节点）。
  const related = new Set<string>();
  for (const edge of merged.values()) {
    related.add(edge.fromAgentId);
    if (edge.toAgentId) related.add(edge.toAgentId);
  }
  for (const agent of sources.agents) {
    if (!isEligible(agent)) continue;
    if (sources.scope.kind === 'tenant') related.add(agent.id);
    else if (sources.scope.appSystemId && agent.appSystemId === sources.scope.appSystemId) related.add(agent.id);
  }

  const hosts: TopologyLearningHost[] = [];
  for (const agent of sources.agents) {
    if (!related.has(agent.id)) continue;
    if (!isEligible(agent)) continue;
    const info = agent.systemInfo;
    const osName = typeof info.osName === 'string'
      ? info.osName
      : typeof info.os === 'string' ? info.os : '';
    const anomalies = [...(sources.anomalies?.get(agent.id) ?? [])].slice(0, 10);
    hosts.push({
      agentId: agent.id,
      hostname: agent.hostname,
      ip: primaryIp.get(agent.id) ?? '',
      appSystemId: agent.appSystemId,
      appSystemName: agent.appSystemName,
      status: agent.status,
      ...(osName ? { os: osName.slice(0, 120) } : {}),
      services: servicesForAgent(agent.id),
      processes: processesForAgent(agent.id),
      anomalies,
    });
  }
  hosts.sort((a, b) => a.hostname.localeCompare(b.hostname));
  const limitedHosts = hosts.slice(0, MAX_HOSTS);
  const keptHostIds = new Set(limitedHosts.map((host) => host.agentId));

  const edges: TopologyLearningEdge[] = [];
  for (const edge of merged.values()) {
    if (!keptHostIds.has(edge.fromAgentId)) continue;
    if (edge.toAgentId && !keptHostIds.has(edge.toAgentId)) continue;
    edges.push({
      fromAgentId: edge.fromAgentId,
      fromHost: edge.fromHost,
      fromService: edge.fromService,
      fromProcess: edge.fromProcess,
      toAgentId: edge.toAgentId,
      toHost: edge.toHost,
      toIp: edge.toIp,
      toPort: edge.toPort,
      toService: edge.toService,
      direction: edge.hasOut && edge.hasIn ? 'both' : edge.hasIn ? 'in' : 'out',
      opened: edge.opened,
      closed: edge.closed,
      failed: edge.failed,
      active: edge.active,
      protocol: edge.protocol,
      ...(edge.lastSeen ? { lastSeen: edge.lastSeen } : {}),
      targetAppSystemId: edge.targetAppSystemId,
      ...(edge.targetAppSystemName ? { targetAppSystemName: edge.targetAppSystemName } : {}),
      ...(edge.external ? { external: true } : {}),
    });
  }
  edges.sort((a, b) => (b.opened + b.active) - (a.opened + a.active));
  const limitedEdges = edges.slice(0, MAX_AGGREGATED_EDGES);

  const externalPeersList = [...externalPeers.values()]
    .map((peer) => ({
      ip: peer.ip,
      port: peer.port,
      processes: [...peer.processes].slice(0, 10),
      opened: peer.opened,
      failed: peer.failed,
      note: externalPeerNote(peer.ip),
    }))
    .sort((a, b) => b.opened - a.opened)
    .slice(0, 200);

  const uniqueExternalIps = new Set(externalPeersList.map((peer) => normalizeTopologyAddress(peer.ip)));
  const systemIds = new Set<string>();
  for (const host of limitedHosts) if (host.appSystemId) systemIds.add(host.appSystemId);
  let totalConnections = 0;
  let failedConnections = 0;
  for (const edge of limitedEdges) {
    totalConnections += edge.opened + edge.active;
    failedConnections += edge.failed;
  }
  const reportingAgents = new Set(sources.edges.map((edge) => edge.agentId));
  // 未归属主机只在整个租户范围学习时计入「已排除」；按应用系统学习时它们本就不在候选范围。
  const excludedUnassigned = !includeUnassigned && sources.scope.kind === 'tenant'
    ? sources.agents.filter((agent) => !agent.appSystemId).length
    : 0;
  const windowSeconds = Math.max(1, Math.round((sources.windowEnd.getTime() - sources.windowStart.getTime()) / 1000));
  const stats: TopologyGraphStats = {
    nodeCount: limitedHosts.length + externalPeersList.length,
    edgeCount: limitedEdges.length,
    hostCount: limitedHosts.length,
    systemCount: systemIds.size,
    // 前端外部节点按 IP 聚合，这里也用唯一外部 IP 数，避免同 IP 多端口把计数放大。
    externalCount: uniqueExternalIps.size,
    totalConnections,
    failedConnections,
    samples: sources.edges.length,
    reportingAgents: reportingAgents.size,
    excludedUnassigned,
  };
  return {
    scope: sources.scope,
    window: {
      start: iso(sources.windowStart),
      end: iso(sources.windowEnd),
      seconds: windowSeconds,
    },
    hosts: limitedHosts,
    edges: limitedEdges,
    externalPeers: externalPeersList,
    stats,
  };
}

// ---------------------------------------------------------------------------
// 纯函数：分析器草稿 → 持久化拓扑图内容
// ---------------------------------------------------------------------------

function emptyMetrics(): TopologyNodeMetrics {
  return { active: 0, opened: 0, closed: 0, failed: 0, inbound: 0, outbound: 0 };
}

/** 节点指标由输入边聚合：本节点作为源算 outbound，作为目标算 inbound。 */
function nodeMetrics(agentId: string | null, ip: string | null, edges: readonly TopologyLearningEdge[]): TopologyNodeMetrics {
  const metrics: { active: number; opened: number; closed: number; failed: number; inbound: number; outbound: number } = emptyMetrics();
  const normalizedIp = ip ? normalizeTopologyAddress(ip) : '';
  for (const edge of edges) {
    const isSource = agentId !== null && edge.fromAgentId === agentId;
    const isTarget = agentId !== null
      ? edge.toAgentId === agentId
      : edge.toAgentId === null && normalizedIp !== '' && normalizeTopologyAddress(edge.toIp) === normalizedIp;
    if (isSource) {
      metrics.outbound += edge.opened;
      metrics.opened += edge.opened;
      metrics.closed += edge.closed;
      metrics.failed += edge.failed;
      metrics.active += edge.active;
    }
    if (isTarget) {
      metrics.inbound += edge.opened;
      metrics.opened += edge.opened;
      metrics.closed += edge.closed;
      metrics.failed += edge.failed;
      metrics.active += edge.active;
    }
  }
  return metrics;
}

const NODE_KINDS: readonly TopologyNodeKind[] = [
  'gateway', 'service', 'database', 'cache', 'mq', 'registry', 'storage',
  'monitoring', 'logging', 'external', 'unknown',
];
const NODE_TIERS: readonly TopologyTier[] = ['access', 'app', 'middleware', 'data', 'ops', 'external'];
/** 旧图兼容：ingress 并入 access，infra 并入 ops。 */
const LEGACY_TIERS: Readonly<Record<string, TopologyTier>> = {
  ingress: 'access',
  infra: 'ops',
};
const NODE_STATUSES: readonly TopologyNodeStatus[] = ['online', 'offline', 'unknown'];
const INSIGHT_SEVERITIES = ['info', 'warning', 'critical'] as const;

function normalizeNodeStatus(value: unknown, fallback: string): TopologyNodeStatus {
  if (typeof value === 'string' && (NODE_STATUSES as readonly string[]).includes(value)) {
    return value as TopologyNodeStatus;
  }
  return fallback === 'online' ? 'online' : fallback === 'offline' ? 'offline' : 'unknown';
}

function normalizeNodeKind(value: unknown): TopologyNodeKind {
  return typeof value === 'string' && (NODE_KINDS as readonly string[]).includes(value)
    ? value as TopologyNodeKind
    : 'unknown';
}

/** 归一化 tier：兼容旧图中的 ingress/infra，未知值回落到 app。 */
export function normalizeTopologyTier(value: unknown): TopologyTier {
  if (typeof value !== 'string') return 'app';
  const legacy = LEGACY_TIERS[value];
  if (legacy) return legacy;
  return (NODE_TIERS as readonly string[]).includes(value) ? value as TopologyTier : 'app';
}

function normalizeServices(value: unknown): TopologyServicePort[] {
  if (!Array.isArray(value)) return [];
  const services: TopologyServicePort[] = [];
  for (const raw of value.slice(0, 20)) {
    const record = asRecord(raw);
    const name = text(record.name, 120);
    const port = Math.floor(num(record.port));
    if (!name || port <= 0 || port > 65535) continue;
    const process = text(record.process, 120);
    const pid = Math.floor(num(record.pid));
    services.push({
      name,
      port,
      ...(process ? { process } : {}),
      ...(pid > 0 ? { pid } : {}),
    });
  }
  return services;
}

function normalizeInsight(value: unknown): TopologyInsight | null {
  const record = asRecord(value);
  const id = text(record.id, 120);
  const title = text(record.title, 200);
  const detail = text(record.detail, 1000);
  if (!id || !title || !detail) return null;
  const severity = typeof record.severity === 'string' && (INSIGHT_SEVERITIES as readonly string[]).includes(record.severity)
    ? record.severity as TopologyInsight['severity']
    : 'info';
  const nodeIds = Array.isArray(record.nodeIds)
    ? record.nodeIds.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : [];
  const edgeIds = Array.isArray(record.edgeIds)
    ? record.edgeIds.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : [];
  return {
    id,
    title,
    detail,
    severity,
    ...(nodeIds.length > 0 ? { nodeIds } : {}),
    ...(edgeIds.length > 0 ? { edgeIds } : {}),
  };
}

function normalizeInsights(value: unknown): TopologyInsight[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    const insight = normalizeInsight(item);
    return insight ? [insight] : [];
  });
}

function normalizeHotPaths(
  value: unknown,
  nodeIds?: ReadonlySet<string>,
  edgeIds?: ReadonlySet<string>,
): TopologyHotPath[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((item) => {
    const record = asRecord(item);
    const label = text(record.label, 200);
    if (!label) return [];
    const pathNodeIds = Array.isArray(record.nodeIds)
      ? record.nodeIds
          .filter((id): id is string => typeof id === 'string' && (nodeIds === undefined || nodeIds.has(id)))
          .slice(0, 20)
      : [];
    const pathEdgeIds = Array.isArray(record.edgeIds)
      ? record.edgeIds
          .filter((id): id is string => typeof id === 'string' && (edgeIds === undefined || edgeIds.has(id)))
          .slice(0, 20)
      : [];
    if (pathNodeIds.length === 0) return [];
    return [{
      label,
      nodeIds: pathNodeIds,
      edgeIds: pathEdgeIds,
      connections: Math.max(0, Math.floor(num(record.connections))),
    }];
  });
}

/** 把分析器返回的分析结论收敛为契约结构（缺失字段用安全默认值）。 */
export function normalizeTopologyAnalysis(
  value: TopologyAnalysis | null | undefined,
  fallbackSummary: string,
  generatedAt: Date,
): TopologyAnalysis {
  const record = asRecord(value);
  const model = text(record.model, 120) || 'heuristic';
  const promptVersion = text(record.promptVersion, 60) || 'v1';
  const confidence = clamp01(record.confidence);
  const durationMs = Math.floor(num(record.durationMs));
  const warning = text(record.warning, MAX_ERROR_LENGTH);
  const fallbackReason = text(record.fallbackReason, MAX_ERROR_LENGTH);
  const trace = asRecord(record.trace);
  const generated = typeof record.generatedAt === 'string' && !Number.isNaN(Date.parse(record.generatedAt))
    ? new Date(record.generatedAt).toISOString()
    : generatedAt.toISOString();
  return {
    summary: text(record.summary, 2000) || fallbackSummary,
    insights: normalizeInsights(record.insights),
    hotPaths: normalizeHotPaths(record.hotPaths),
    risks: normalizeInsights(record.risks),
    model,
    promptVersion,
    generatedAt: generated,
    confidence,
    ...(durationMs > 0 ? { durationMs } : {}),
    fallback: record.fallback === true,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(trace ? { trace: trace as unknown as TopologyAnalysisTrace } : {}),
    ...(warning ? { warning } : {}),
  };
}

export interface TopologyGraphPayload {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly systems: readonly TopologySystemGroup[];
  readonly analysis: TopologyAnalysis;
  readonly stats: TopologyGraphStats;
}

export interface BuildGraphPayloadArgs {
  readonly input: TopologyLearningInput;
  readonly draft: TopologyDraft;
  readonly analysis: TopologyAnalysis | null | undefined;
  readonly generatedAt: Date;
  /** false 时不生成「未归属」业务系统分组（默认 false，V2 行为）。 */
  readonly includeUnassigned?: boolean;
}

/**
 * 草稿图 → 落库内容：
 * - 节点指标由输入边重新聚合（不信任模型给的流量数字）；
 * - 草稿边与真实观测边匹配后用真实计数覆盖，匹配不到才降置信度；
 * - 草稿缺失节点/边时用输入兜底，保证页面永远有图。
 */
export function buildGraphPayload(args: BuildGraphPayloadArgs): TopologyGraphPayload {
  const { input } = args;
  const hostsById = new Map(input.hosts.map((host) => [host.agentId, host]));
  const hostsByHostname = new Map(input.hosts.map((host) => [host.hostname.toLowerCase(), host]));
  const hostsByIp = new Map(
    input.hosts
      .filter((host) => host.ip)
      .map((host) => [normalizeTopologyAddress(host.ip), host] as const),
  );

  const draftNodes = (Array.isArray(args.draft?.nodes) ? args.draft.nodes : []).slice(0, MAX_DRAFT_NODES);
  const hostByNodeId = new Map<string, TopologyLearningHost>();
  const ipByNodeId = new Map<string, string>();
  const nodes: TopologyNode[] = [];
  const nodeIds = new Set<string>();
  for (const rawNode of draftNodes) {
    const node = asRecord(rawNode);
    const id = text(node.id, 160);
    if (!id || nodeIds.has(id)) continue;
    const host = hostsById.get(id)
      ?? (typeof node.hostname === 'string' ? hostsByHostname.get(node.hostname.toLowerCase()) : undefined)
      ?? (typeof node.ip === 'string' && node.ip ? hostsByIp.get(normalizeTopologyAddress(node.ip)) : undefined);
    if (host) hostByNodeId.set(id, host);
    const ip = typeof node.ip === 'string' && node.ip ? node.ip.slice(0, 160) : host?.ip ?? '';
    if (ip) ipByNodeId.set(id, ip);
    const hostname = typeof node.hostname === 'string' && node.hostname ? node.hostname.slice(0, 200) : host?.hostname ?? '';
    const appSystemId = typeof node.appSystemId === 'string' && node.appSystemId
      ? node.appSystemId
      : host?.appSystemId ?? null;
    const appSystemName = typeof node.appSystemName === 'string' && node.appSystemName
      ? node.appSystemName.slice(0, 200)
      : host?.appSystemName ?? '';
    const anomalies = (Array.isArray(node.anomalies) ? node.anomalies : [])
      .filter((item): item is string => typeof item === 'string')
      .slice(0, 10);
    const services = Array.isArray(node.services) ? normalizeServices(node.services) : host?.services ?? [];
    nodes.push({
      id,
      label: text(node.label, 200) || hostname || id,
      kind: normalizeNodeKind(node.kind),
      tier: normalizeTopologyTier(node.tier),
      ...(hostname ? { hostname } : {}),
      ...(ip ? { ip } : {}),
      appSystemId,
      ...(appSystemName ? { appSystemName } : {}),
      status: normalizeNodeStatus(node.status, host?.status ?? 'unknown'),
      services,
      metrics: nodeMetrics(host?.agentId ?? null, ip || null, input.edges),
      ...(text(node.product, 80) ? { product: text(node.product, 80) } : {}),
      ...(text(node.role, 200) ? { role: text(node.role, 200) } : {}),
      ...(typeof node.systemService === 'boolean' ? { systemService: node.systemService } : {}),
      ...(anomalies.length > 0 ? { anomalies } : {}),
      ...(node.inferred === true ? { inferred: true } : {}),
      ...(text(node.note, 500) ? { note: text(node.note, 500) } : {}),
    });
    nodeIds.add(id);
  }

  let effectiveNodes = nodes;
  if (effectiveNodes.length === 0) {
    // 分析器异常时仍用输入兜底，避免学习会话因空图失败。
    const externalNodes = new Map<string, TopologyNode>();
    for (const peer of input.externalPeers) {
      const id = `external:${peer.ip}`;
      if (!externalNodes.has(id)) {
        externalNodes.set(id, {
          id,
          label: peer.ip,
          kind: 'external',
          tier: 'external',
          ip: peer.ip,
          appSystemId: null,
          status: 'unknown',
          services: [],
          metrics: nodeMetrics(null, peer.ip, input.edges),
          inferred: true,
          note: peer.note ?? '未纳管',
        });
        nodeIds.add(id);
      }
    }
    const hostNodes: TopologyNode[] = input.hosts.map((host) => ({
      id: host.agentId,
      label: host.hostname || host.ip || host.agentId,
      kind: 'service',
      tier: 'app',
      ...(host.hostname ? { hostname: host.hostname } : {}),
      ...(host.ip ? { ip: host.ip } : {}),
      appSystemId: host.appSystemId,
      ...(host.appSystemName ? { appSystemName: host.appSystemName } : {}),
      status: normalizeNodeStatus(host.status, host.status),
      services: host.services,
      metrics: nodeMetrics(host.agentId, host.ip || null, input.edges),
      ...(host.anomalies.length > 0 ? { anomalies: [...host.anomalies] } : {}),
    }));
    for (const node of hostNodes) {
      if (nodeIds.has(node.id)) continue;
      nodeIds.add(node.id);
      const host = hostsById.get(node.id);
      if (host) hostByNodeId.set(node.id, host);
    }
    effectiveNodes = [...hostNodes, ...externalNodes.values()];
  }

  // 输入边索引：管理网对端按 agentId，外部对端按 IP。
  const inputEdgeIndex = new Map<string, TopologyLearningEdge>();
  for (const edge of input.edges) {
    const key = edge.toAgentId
      ? `${edge.fromAgentId}|${edge.toAgentId}|${edge.toPort}`
      : `${edge.fromAgentId}|ip:${normalizeTopologyAddress(edge.toIp)}|${edge.toPort}`;
    if (!inputEdgeIndex.has(key)) inputEdgeIndex.set(key, edge);
  }

  const externalNodeIds = new Set(
    effectiveNodes.filter((node) => node.kind === 'external').map((node) => node.id),
  );
  const nodeById = new Map(effectiveNodes.map((node) => [node.id, node]));
  const relationNameOf = (id: string): string => {
    const node = nodeById.get(id);
    return node ? topologyNodeRelationName(node) : id;
  };
  const edgeIds = new Set<string>();
  const edges: TopologyEdge[] = [];
  const seenEdges = new Map<string, number>();
  const rawDraftEdges = (Array.isArray(args.draft?.edges) ? args.draft.edges : []).slice(0, MAX_DRAFT_EDGES);
  const pushDraftEdge = (draftEdge: TopologyDraftEdge): void => {
    const record = asRecord(draftEdge);
    const source = text(record.source, 160);
    const target = text(record.target, 160);
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) return;
    const port = Math.min(Math.max(Math.floor(num(record.port)), 0), 65535);
    const sourceHost = hostByNodeId.get(source);
    const targetHost = hostByNodeId.get(target);
    const targetIp = ipByNodeId.get(target) ?? targetHost?.ip ?? '';
    const matched = sourceHost
      ? inputEdgeIndex.get(
          targetHost
            ? `${sourceHost.agentId}|${targetHost.agentId}|${port}`
            : `${sourceHost.agentId}|ip:${normalizeTopologyAddress(targetIp)}|${port}`,
        )
      : undefined;
    const direction = matched?.direction;
    const count = matched ? matched.opened + matched.active : Math.max(0, Math.floor(num(record.count)));
    const opened = matched ? matched.opened : nonNegative(record.opened);
    const failed = matched ? matched.failed : nonNegative(record.failed);
    const confidence = clamp01(record.confidence ?? (matched ? (direction === 'both' ? 0.95 : 0.9) : 0.55));
    // 与分析器 topologyEdgeId 同口径（`e:${source}->${target}:${port}`）：
    // hotPaths/insights 的 edgeIds 直接引用该 id，前缀不一致会导致页面定位不到边。
    const id = `e:${source}->${target}:${port}`.slice(0, 400);
    const key = `${source}|${target}|${port}`;
    const existingIndex = seenEdges.get(key);
    if (existingIndex !== undefined) {
      const existing = edges[existingIndex];
      if (existing) {
        edges[existingIndex] = {
          ...existing,
          count: existing.count + count,
          opened: existing.opened + opened,
          failed: existing.failed + failed,
          confidence: Math.max(existing.confidence, confidence),
        };
      }
      return;
    }
    const processes = matched?.fromProcess ? [matched.fromProcess] : [];
    const external = matched?.external === true || externalNodeIds.has(target) || targetHost === undefined;
    // 页面直接消费 label：分析器没给时用「目标节点:端口」补一个可读标签。
    const label = text(record.label, 200) || `${nodeById.get(target)?.label ?? target}:${port}`;
    edges.push({
      id,
      source,
      target,
      protocol: text(record.protocol, 20) || 'tcp',
      port,
      count,
      countBasis: matched ? 'observed' : 'opened',
      opened,
      failed,
      confidence,
      ...(direction ? { direction } : {}),
      ...(processes.length > 0 ? { processes } : {}),
      ...(matched?.lastSeen ? { lastSeen: matched.lastSeen } : {}),
      ...(external ? { external: true } : {}),
      label,
      relationKey: topologyRelationKey(relationNameOf(source), relationNameOf(target), port),
    });
    seenEdges.set(key, edges.length - 1);
    edgeIds.add(id);
  };
  for (const draftEdge of rawDraftEdges) pushDraftEdge(draftEdge);

  if (edges.length === 0) {
    // 兜底：按输入边生成观测边（id 使用 agentId / external:ip）。
    for (const edge of input.edges.slice(0, MAX_DRAFT_EDGES)) {
      const source = edge.fromAgentId;
      const target = edge.toAgentId ?? `external:${edge.toIp}`;
      if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) continue;
      const id = `e:${source}->${target}:${edge.toPort}`.slice(0, 400);
      if (edgeIds.has(id)) continue;
      const processes = [edge.fromProcess].filter(Boolean).slice(0, 8);
      edges.push({
        id,
        source,
        target,
        protocol: 'tcp',
        port: edge.toPort,
        count: edge.opened + edge.active,
        countBasis: 'observed',
        opened: edge.opened,
        failed: edge.failed,
        confidence: edge.direction === 'both' ? 0.95 : 0.9,
        direction: edge.direction,
        label: `${nodeById.get(target)?.label ?? target}:${edge.toPort}`,
        relationKey: topologyRelationKey(relationNameOf(source), relationNameOf(target), edge.toPort),
        ...(processes.length > 0 ? { processes } : {}),
        ...(edge.lastSeen ? { lastSeen: edge.lastSeen } : {}),
        ...(edge.external ? { external: true } : {}),
      });
      edgeIds.add(id);
    }
  }

  // 业务系统分组：优先用分析器给的，缺失时按主机归属回填。
  const systems: TopologySystemGroup[] = [];
  const includeUnassigned = args.includeUnassigned === true;
  const rawSystems = Array.isArray(args.draft?.systems) ? args.draft.systems : [];
  for (const rawSystem of rawSystems.slice(0, 50)) {
    const record = asRecord(rawSystem);
    const id = text(record.id, 160);
    const name = text(record.name, 200);
    if (!id || !name) continue;
    // 默认排除未归属主机时，也不生成「未归属」业务系统分组。
    if (!includeUnassigned && (name.includes('未归属') || id === '__unassigned__')) continue;
    const members = Array.isArray(record.nodeIds)
      ? record.nodeIds.filter((item): item is string => typeof item === 'string' && nodeIds.has(item)).slice(0, 200)
      : [];
    if (members.length === 0) continue;
    systems.push({
      id,
      name,
      ...(text(record.code, 80) ? { code: text(record.code, 80) } : {}),
      nodeIds: members,
      ...(text(record.criticality, 20) ? { criticality: text(record.criticality, 20) } : {}),
    });
  }
  if (systems.length === 0) {
    const groups = new Map<string, { name: string; nodeIds: string[] }>();
    const unassignedNodeIds: string[] = [];
    for (const node of effectiveNodes) {
      if (!node.appSystemId) {
        if (includeUnassigned && node.kind !== 'external') unassignedNodeIds.push(node.id);
        continue;
      }
      const group = groups.get(node.appSystemId) ?? { name: node.appSystemName ?? '未归属', nodeIds: [] };
      group.nodeIds.push(node.id);
      groups.set(node.appSystemId, group);
    }
    for (const [id, group] of groups) {
      systems.push({ id, name: group.name, nodeIds: group.nodeIds });
    }
    if (unassignedNodeIds.length > 0) {
      systems.push({ id: '__unassigned__', name: '未归属', nodeIds: unassignedNodeIds });
    }
  }

  const analysis = normalizeTopologyAnalysis(args.analysis, '', args.generatedAt);
  const analysisWithGraphRefs: TopologyAnalysis = {
    ...analysis,
    hotPaths: normalizeHotPaths(args.analysis?.hotPaths, nodeIds, edgeIds),
    ...(analysis.summary ? {} : {
      summary: `学习窗口内共 ${effectiveNodes.length} 个节点、${edges.length} 条访问关系。`,
    }),
  };

  const finalStats: TopologyGraphStats = {
    nodeCount: effectiveNodes.length,
    edgeCount: edges.length,
    hostCount: input.stats.hostCount,
    systemCount: new Set(
      systems.filter((system) => system.name !== '未归属').map((system) => system.id),
    ).size,
    // 外部依赖按唯一 IP 计数，与前端外部节点口径一致。
    externalCount: Math.max(
      input.stats.externalCount,
      new Set(
        effectiveNodes
          .filter((node) => node.kind === 'external')
          .map((node) => normalizeTopologyAddress(node.ip ?? node.label))
          .filter(Boolean),
      ).size,
    ),
    totalConnections: edges.reduce((sum, edge) => sum + edge.count, 0),
    failedConnections: edges.reduce((sum, edge) => sum + edge.failed, 0),
    samples: input.stats.samples,
    reportingAgents: input.stats.reportingAgents,
    excludedUnassigned: input.stats.excludedUnassigned ?? 0,
  };

  return {
    nodes: effectiveNodes,
    edges,
    systems,
    analysis: analysisWithGraphRefs,
    stats: finalStats,
  };
}

// ---------------------------------------------------------------------------
// DB 行 → 契约对象
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  tenant_id: string;
  scope_kind: 'tenant' | 'app-system';
  app_system_id: string | null;
  window_seconds: number;
  status: TopologyLearningStatus;
  requested_by: string | null;
  trigger: string;
  started_at: Date;
  ends_at: Date;
  completed_at: Date | null;
  model: string;
  prompt_version: string;
  fallback: boolean;
  include_unassigned: boolean;
  graph_id: string | null;
  progress: unknown;
  stats: unknown;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  app_system_name: string | null;
}

interface GraphRow {
  id: string;
  tenant_id: string;
  session_id: string;
  scope_kind: 'tenant' | 'app-system';
  app_system_id: string | null;
  mode: 'host' | 'app-system';
  version: number;
  window_start: Date;
  window_end: Date;
  window_seconds: number;
  nodes: unknown;
  edges: unknown;
  systems: unknown;
  analysis: unknown;
  stats: unknown;
  model: string;
  prompt_version: string;
  fallback: boolean;
  created_at: Date;
  app_system_name: string | null;
}

interface PolicyRow {
  tenant_id: string;
  enabled: boolean;
  interval_seconds: number;
  window_seconds: number;
  scope_kind: 'tenant' | 'app-system';
  app_system_id: string | null;
  include_unassigned: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
  updated_at: Date;
  app_system_name: string | null;
}

function progressFromValue(value: unknown): TopologyLearningProgress {
  const record = asRecord(value);
  return {
    elapsedSeconds: nonNegative(record.elapsedSeconds),
    remainingSeconds: nonNegative(record.remainingSeconds),
    percent: Math.min(100, nonNegative(record.percent)),
    reportingAgents: nonNegative(record.reportingAgents),
    expectedAgents: nonNegative(record.expectedAgents),
    edgeSamples: nonNegative(record.edgeSamples),
    uniqueEdges: nonNegative(record.uniqueEdges),
    phase: text(record.phase, 40) || 'collecting',
  };
}

function statsFromValue(value: unknown): TopologyGraphStats | null {
  const record = asRecord(value);
  if (typeof record.nodeCount !== 'number') return null;
  return {
    nodeCount: nonNegative(record.nodeCount),
    edgeCount: nonNegative(record.edgeCount),
    hostCount: nonNegative(record.hostCount),
    systemCount: nonNegative(record.systemCount),
    externalCount: nonNegative(record.externalCount),
    totalConnections: nonNegative(record.totalConnections),
    failedConnections: nonNegative(record.failedConnections),
    samples: nonNegative(record.samples),
    reportingAgents: nonNegative(record.reportingAgents),
    ...(typeof record.excludedUnassigned === 'number'
      ? { excludedUnassigned: nonNegative(record.excludedUnassigned) }
      : {}),
  };
}

function scopeFromColumns(
  kind: 'tenant' | 'app-system',
  appSystemId: string | null,
  appSystemName: string | null,
): TopologyScope {
  if (kind === 'app-system' && appSystemId) {
    return {
      kind: 'app-system',
      appSystemId,
      ...(appSystemName ? { appSystemName } : {}),
    };
  }
  return { kind: 'tenant', appSystemId: null };
}

function sessionFromRow(row: SessionRow): TopologyLearningSession {
  const stats = statsFromValue(row.stats);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: scopeFromColumns(row.scope_kind, row.app_system_id, row.app_system_name),
    windowSeconds: row.window_seconds,
    status: row.status,
    startedAt: iso(row.started_at),
    endsAt: iso(row.ends_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    progress: progressFromValue(row.progress),
    includeUnassigned: row.include_unassigned === true,
    graphId: row.graph_id,
    model: row.model || null,
    fallback: row.fallback,
    error: row.error,
    ...(stats ? { stats } : {}),
  };
}

/** 读取旧图时归一化节点：兼容旧 tier（ingress→access、infra→ops）与新增可选字段。 */
function normalizeStoredNode(value: unknown): TopologyNode | null {
  const record = asRecord(value);
  const id = text(record.id, 160);
  if (!id) return null;
  const metrics = asRecord(record.metrics);
  const anomalies = Array.isArray(record.anomalies)
    ? record.anomalies.filter((item): item is string => typeof item === 'string').slice(0, 10)
    : [];
  return {
    id,
    label: text(record.label, 200) || id,
    kind: normalizeNodeKind(record.kind),
    tier: normalizeTopologyTier(record.tier),
    ...(text(record.hostname, 200) ? { hostname: text(record.hostname, 200) } : {}),
    ...(text(record.ip, 160) ? { ip: text(record.ip, 160) } : {}),
    appSystemId: typeof record.appSystemId === 'string' && record.appSystemId ? record.appSystemId : null,
    ...(text(record.appSystemName, 200) ? { appSystemName: text(record.appSystemName, 200) } : {}),
    status: normalizeNodeStatus(record.status, 'unknown'),
    services: normalizeServices(record.services),
    metrics: {
      active: nonNegative(metrics.active),
      opened: nonNegative(metrics.opened),
      closed: nonNegative(metrics.closed),
      failed: nonNegative(metrics.failed),
      inbound: nonNegative(metrics.inbound),
      outbound: nonNegative(metrics.outbound),
    },
    ...(anomalies.length > 0 ? { anomalies } : {}),
    ...(text(record.product, 80) ? { product: text(record.product, 80) } : {}),
    ...(text(record.role, 200) ? { role: text(record.role, 200) } : {}),
    ...(typeof record.systemService === 'boolean' ? { systemService: record.systemService } : {}),
    ...(record.inferred === true ? { inferred: true } : {}),
    ...(text(record.note, 500) ? { note: text(record.note, 500) } : {}),
  };
}

function graphFromRow(row: GraphRow): TopologyGraph {
  const analysis = normalizeTopologyAnalysis(row.analysis as TopologyAnalysis, '', row.created_at);
  const stats = statsFromValue(row.stats) ?? {
    nodeCount: 0,
    edgeCount: 0,
    hostCount: 0,
    systemCount: 0,
    externalCount: 0,
    totalConnections: 0,
    failedConnections: 0,
    samples: 0,
    reportingAgents: 0,
  };
  const graph: TopologyGraph = {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    scope: scopeFromColumns(row.scope_kind, row.app_system_id, row.app_system_name),
    mode: row.mode,
    window: {
      start: iso(row.window_start),
      end: iso(row.window_end),
      seconds: row.window_seconds,
    },
    nodes: Array.isArray(row.nodes)
      ? row.nodes.flatMap((item) => {
          const node = normalizeStoredNode(item);
          return node ? [node] : [];
        })
      : [],
    edges: Array.isArray(row.edges) ? row.edges as TopologyEdge[] : [],
    systems: Array.isArray(row.systems) ? row.systems as TopologySystemGroup[] : [],
    analysis,
    stats,
    createdAt: iso(row.created_at),
    version: row.version,
  };
  return backfillGraphRelationKeys(graph);
}

function policyFromRow(row: PolicyRow): TopologyLearningPolicy {
  return {
    tenantId: row.tenant_id,
    enabled: row.enabled,
    intervalSeconds: row.interval_seconds,
    windowSeconds: row.window_seconds,
    scope: scopeFromColumns(row.scope_kind, row.app_system_id, row.app_system_name),
    includeUnassigned: row.include_unassigned === true,
    lastRunAt: row.last_run_at ? iso(row.last_run_at) : null,
    nextRunAt: row.next_run_at ? iso(row.next_run_at) : null,
    updatedAt: iso(row.updated_at),
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

export interface StartLearningOptions {
  readonly trigger?: 'manual' | 'schedule';
  readonly requestedBy?: string | null;
}

export interface TopologyLearningTickResult {
  readonly aggregated: number;
  readonly failed: number;
  readonly scheduled: number;
}

const SESSION_SELECT = `SELECT s.*, a.name AS app_system_name
  FROM topology_learning_sessions s
  LEFT JOIN app_systems a ON a.id = s.app_system_id`;

/** 固定时间窗学习会话服务：创建/进度/窗口结束聚合/分析/落库/策略。 */
export class TopologyLearningService {
  private readonly completion: ModelCompletionService;
  private readonly models: ModelProviderService;
  private readonly edgeTags: TopologyEdgeTagService;
  private analyzerInstance: TopologyAnalyzerLike | undefined;

  constructor(
    private readonly pool: Pool,
    modelSecret = process.env.OPSAGENT_SECRET_KEY ?? 'dev-only-secret',
    analyzer?: TopologyAnalyzerLike,
  ) {
    this.models = new ModelProviderService(pool, modelSecret);
    this.completion = new ModelCompletionService(this.models);
    this.edgeTags = new TopologyEdgeTagService(pool);
    this.analyzerInstance = analyzer;
  }

  /** 解析学习范围并校验应用系统租户归属。 */
  async resolveScope(tenantId: string, appSystemId: string | null): Promise<TopologyScope> {
    if (!appSystemId) return { kind: 'tenant', appSystemId: null };
    const result = await this.pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM app_systems WHERE tenant_id = $1 AND id = $2',
      [tenantId, appSystemId],
    );
    const row = result.rows[0];
    if (!row) throw new TopologyLearningError('app_system_not_found');
    return { kind: 'app-system', appSystemId: row.id, appSystemName: row.name };
  }

  /** 创建（或复用）固定时间窗学习会话。 */
  async start(
    tenantId: string,
    input: {
      readonly appSystemId?: string | null;
      readonly windowSeconds?: number;
      /** 默认 false：未归属应用系统的主机不进入拓扑。 */
      readonly includeUnassigned?: boolean;
    },
    options: StartLearningOptions = {},
  ): Promise<TopologyLearningSession> {
    const windowSeconds = input.windowSeconds === undefined
      ? TOPOLOGY_WINDOW_DEFAULT_SECONDS
      : input.windowSeconds;
    if (!Number.isInteger(windowSeconds)
      || windowSeconds < TOPOLOGY_WINDOW_MIN_SECONDS
      || windowSeconds > TOPOLOGY_WINDOW_MAX_SECONDS) {
      throw new TopologyLearningError('invalid_window');
    }
    const includeUnassigned = input.includeUnassigned === true;
    const requested = typeof input.appSystemId === 'string' && input.appSystemId.trim()
      ? input.appSystemId.trim()
      : null;
    const scope = await this.resolveScope(tenantId, requested);
    const trigger = options.trigger ?? 'manual';

    // 同租户同 scope 已有活动会话时复用，避免重复采集。
    const active = await this.findActiveSession(tenantId, scope.appSystemId ?? null);
    if (active) return active;

    // 默认排除未归属主机：范围内没有已归属主机时不创建会话，直接提示先归属应用系统。
    if (!includeUnassigned) {
      const managed = await this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM agents
         WHERE tenant_id = $1 AND app_system_id IS NOT NULL
           AND ($2::uuid IS NULL OR app_system_id = $2)`,
        [tenantId, scope.appSystemId ?? null],
      );
      if ((managed.rows[0]?.count ?? 0) === 0) throw new TopologyLearningError('no_managed_hosts');
    }

    const expectedAgents = await this.expectedAgents(tenantId, scope.appSystemId ?? null, includeUnassigned);
    const progress: TopologyLearningProgress = {
      elapsedSeconds: 0,
      remainingSeconds: windowSeconds,
      percent: 0,
      reportingAgents: 0,
      expectedAgents,
      edgeSamples: 0,
      uniqueEdges: 0,
      phase: 'collecting',
    };
    const result = await this.pool.query<SessionRow>(
      `WITH inserted AS (
         INSERT INTO topology_learning_sessions
           (tenant_id, scope_kind, app_system_id, window_seconds, status, requested_by, trigger,
            include_unassigned, started_at, ends_at, progress, stats, updated_at)
         VALUES ($1, $2, $3, $4::integer, 'collecting', $5, $6, $7,
                 now(), now() + ($4::integer * interval '1 second'), $8::jsonb, '{}'::jsonb, now())
         RETURNING *
       )
       SELECT i.*, a.name AS app_system_name
       FROM inserted i LEFT JOIN app_systems a ON a.id = i.app_system_id`,
      [
        tenantId,
        scope.kind,
        scope.appSystemId ?? null,
        windowSeconds,
        options.requestedBy ?? null,
        trigger,
        includeUnassigned,
        JSON.stringify(progress),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new TopologyLearningError('session_create_failed');
    return sessionFromRow(row);
  }

  private async findActiveSession(tenantId: string, appSystemId: string | null): Promise<TopologyLearningSession | null> {
    const result = await this.pool.query<SessionRow>(
      `${SESSION_SELECT}
       WHERE s.tenant_id = $1 AND s.status IN ('collecting', 'aggregating', 'analyzing')
         AND s.app_system_id IS NOT DISTINCT FROM $2::uuid
       ORDER BY s.created_at DESC LIMIT 1`,
      [tenantId, appSystemId],
    );
    const row = result.rows[0];
    return row ? sessionFromRow(row) : null;
  }

  /** 当前活动会话（含进度），没有返回 null。 */
  async active(tenantId: string, appSystemId: string | null): Promise<TopologyLearningSession | null> {
    const session = await this.findActiveSession(tenantId, appSystemId);
    if (!session) return null;
    return this.progress(tenantId, session.id);
  }

  async getSession(tenantId: string, sessionId: string): Promise<TopologyLearningSession | null> {
    const result = await this.pool.query<SessionRow>(
      `${SESSION_SELECT} WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenantId, sessionId],
    );
    const row = result.rows[0];
    return row ? sessionFromRow(row) : null;
  }

  private async expectedAgents(
    tenantId: string,
    appSystemId: string | null,
    includeUnassigned = true,
  ): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM agents
       WHERE tenant_id = $1 AND ($2::uuid IS NULL OR app_system_id = $2)
         AND ($3::boolean OR app_system_id IS NOT NULL)`,
      [tenantId, appSystemId, includeUnassigned],
    );
    return result.rows[0]?.count ?? 0;
  }

  /**
   * 计算并写回会话进度：
   * elapsed/remaining/percent/phase + 期望主机数、窗口内实际上报主机数、边样本数、去重边数。
   */
  async progress(tenantId: string, sessionId: string): Promise<TopologyLearningSession | null> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) return null;
    const scope = session.scope;
    const now = Date.now();
    const startMs = Date.parse(session.startedAt);
    const endMs = Date.parse(session.endsAt);
    const windowMs = Math.max(1, session.windowSeconds * 1000);
    const elapsedRaw = Math.floor((now - startMs) / 1000);
    const elapsedSeconds = Math.min(session.windowSeconds, Math.max(0, elapsedRaw));
    const remainingSeconds = session.status === 'collecting'
      ? Math.max(0, Math.ceil((endMs - now) / 1000))
      : 0;
    const percent = session.status === 'collecting'
      ? Math.min(100, Math.floor((Math.max(0, now - startMs) / windowMs) * 100))
      : 100;

    const sample = await this.pool.query<{ agents: number; samples: number; unique_edges: number }>(
      `SELECT count(DISTINCT e.agent_id)::int AS agents,
              count(*)::int AS samples,
              count(DISTINCT (e.agent_id, e.direction, e.process, e.pid,
                              e.local_address, e.local_port, e.peer_address, e.peer_port))::int AS unique_edges
       FROM agent_connection_edges e
       JOIN agents a ON a.id = e.agent_id AND a.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1 AND e.window_end > $2 AND e.window_start < $3
         AND ($4::uuid IS NULL OR a.app_system_id = $4)
         AND ($5::boolean OR a.app_system_id IS NOT NULL)`,
      [tenantId, session.startedAt, session.endsAt, scope.appSystemId ?? null, session.includeUnassigned],
    );
    const expected = session.progress.expectedAgents
      || await this.expectedAgents(tenantId, scope.appSystemId ?? null, session.includeUnassigned);
    const sampleRow = sample.rows[0];
    const progress: TopologyLearningProgress = {
      elapsedSeconds,
      remainingSeconds,
      percent,
      reportingAgents: sampleRow?.agents ?? 0,
      expectedAgents: expected,
      edgeSamples: sampleRow?.samples ?? 0,
      uniqueEdges: sampleRow?.unique_edges ?? 0,
      phase: session.status,
    };
    if (session.status === 'collecting') {
      await this.pool.query(
        `UPDATE topology_learning_sessions SET progress = $3::jsonb, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'collecting'`,
        [tenantId, sessionId, JSON.stringify(progress)],
      );
    }
    return {
      ...session,
      progress,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 每 10s 调用：到期 collecting → aggregating 并异步 finalize；analyzing 超时置 failed；处理自动学习策略。 */
  async tick(options: { autoLearn?: boolean } = {}): Promise<TopologyLearningTickResult> {
    let aggregated = 0;
    let failed = 0;
    let scheduled = 0;
    try {
      const due = await this.pool.query<{ id: string; tenant_id: string }>(
        `UPDATE topology_learning_sessions
         SET status = 'aggregating', updated_at = now()
         WHERE status = 'collecting' AND ends_at <= now()
         RETURNING id, tenant_id`,
      );
      aggregated = due.rowCount ?? 0;
      for (const row of due.rows) {
        void this.finalize(row.tenant_id, row.id).catch((error) => {
          console.error('[topology] finalize failed', row.id, error);
        });
      }
    } catch (error) {
      console.error('[topology] aggregating transition failed', error);
    }
    try {
      const stale = await this.pool.query(
        `UPDATE topology_learning_sessions
         SET status = 'failed', error = 'analyzer_timeout', completed_at = now(), updated_at = now()
         WHERE status = 'analyzing' AND updated_at < now() - interval '10 minutes'`,
      );
      failed = stale.rowCount ?? 0;
    } catch (error) {
      console.error('[topology] analyzing timeout scan failed', error);
    }
    if (options.autoLearn !== false) {
      try {
        scheduled = await this.runDuePolicies();
      } catch (error) {
        console.error('[topology] auto learning policies failed', error);
      }
    }
    return { aggregated, failed, scheduled };
  }

  private async runDuePolicies(): Promise<number> {
    const due = await this.pool.query<PolicyRow>(
      `${POLICY_SELECT}
       WHERE p.enabled AND (p.next_run_at IS NULL OR p.next_run_at <= now())
       ORDER BY p.next_run_at NULLS FIRST LIMIT 20`,
    );
    let started = 0;
    for (const row of due.rows) {
      const scope = scopeFromColumns(row.scope_kind, row.app_system_id, row.app_system_name);
      try {
        await this.start(
          row.tenant_id,
          {
            appSystemId: scope.appSystemId ?? null,
            windowSeconds: row.window_seconds,
            includeUnassigned: row.include_unassigned === true,
          },
          { trigger: 'schedule' },
        );
        await this.pool.query(
          `UPDATE topology_learning_policies
           SET last_run_at = now(),
               next_run_at = now() + make_interval(secs => interval_seconds),
               updated_at = now()
           WHERE tenant_id = $1`,
          [row.tenant_id],
        );
        started += 1;
      } catch (error) {
        // 单个租户失败不影响其它租户；顺延一个周期，避免每 10s 重试。
        console.error('[topology] scheduled learning failed', row.tenant_id, error);
        await this.pool.query(
          `UPDATE topology_learning_policies
           SET next_run_at = now() + make_interval(secs => interval_seconds), updated_at = now()
           WHERE tenant_id = $1`,
          [row.tenant_id],
        ).catch(() => undefined);
      }
    }
    return started;
  }

  /**
   * 窗口结束后的聚合 + 分析 + 落库。
   * 会话状态置 analyzing；成功 ready 并写 graph_id，失败 failed + error（截断 500 字）。
   */
  async finalize(tenantId: string, sessionId: string): Promise<TopologyLearningSession | null> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) return null;
    if (session.status === 'collecting') throw new TopologyLearningError('session_collecting');
    if (session.status === 'cancelled') throw new TopologyLearningError('session_cancelled');
    const claimed = await this.pool.query(
      `UPDATE topology_learning_sessions
       SET status = 'analyzing', error = NULL, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status IN ('aggregating', 'analyzing', 'ready', 'failed')
       RETURNING id`,
      [tenantId, sessionId],
    );
    if ((claimed.rowCount ?? 0) === 0) throw new TopologyLearningError('session_not_analyzable');
    try {
      const input = await this.collectInput(session);
      const analyzer = this.resolveAnalyzer();
      // 传真实模型名，避免页面把 analysis.model 显示为内部调试值 'llm'。
      const modelLabel = await this.resolveModelLabel(tenantId);
      const result = await analyzer.analyze(tenantId, input, modelLabel ? { modelLabel } : undefined);
      const draft: TopologyDraft = result?.draft ?? { nodes: [], edges: [] };
      const generatedAt = new Date();
      const payload = buildGraphPayload({
        input,
        draft,
        analysis: result?.analysis,
        generatedAt,
        includeUnassigned: session.includeUnassigned,
      });
      const versionRow = await this.pool.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM topology_graphs
         WHERE tenant_id = $1 AND scope_kind = $2 AND app_system_id IS NOT DISTINCT FROM $3::uuid`,
        [tenantId, session.scope.kind, session.scope.appSystemId ?? null],
      );
      const version = versionRow.rows[0]?.version ?? 1;
      const mode: 'host' | 'app-system' = session.scope.kind === 'app-system' ? 'app-system' : 'host';
      const inserted = await this.pool.query<{ id: string }>(
        `INSERT INTO topology_graphs
           (tenant_id, session_id, scope_kind, app_system_id, mode, version,
            window_start, window_end, window_seconds, nodes, edges, systems, analysis, stats,
            model, prompt_version, fallback, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
                 $15, $16, $17, now())
         RETURNING id`,
        [
          tenantId,
          sessionId,
          session.scope.kind,
          session.scope.appSystemId ?? null,
          mode,
          version,
          session.startedAt,
          session.endsAt,
          session.windowSeconds,
          JSON.stringify(payload.nodes),
          JSON.stringify(payload.edges),
          JSON.stringify(payload.systems),
          JSON.stringify(payload.analysis),
          JSON.stringify(payload.stats),
          payload.analysis.model,
          payload.analysis.promptVersion,
          payload.analysis.fallback === true,
        ],
      );
      const graphId = inserted.rows[0]?.id;
      if (!graphId) throw new Error('graph_insert_failed');
      const finalProgress: TopologyLearningProgress = {
        elapsedSeconds: session.windowSeconds,
        remainingSeconds: 0,
        percent: 100,
        reportingAgents: payload.stats.reportingAgents,
        expectedAgents: session.progress.expectedAgents,
        edgeSamples: payload.stats.samples,
        uniqueEdges: payload.stats.edgeCount,
        phase: 'ready',
      };
      await this.pool.query(
        `UPDATE topology_learning_sessions
         SET status = 'ready', graph_id = $3, model = $4, prompt_version = $5, fallback = $6,
             stats = $7::jsonb, progress = $8::jsonb, error = NULL,
             completed_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          sessionId,
          graphId,
          payload.analysis.model,
          payload.analysis.promptVersion,
          payload.analysis.fallback === true,
          JSON.stringify(payload.stats),
          JSON.stringify(finalProgress),
        ],
      );
      return this.getSession(tenantId, sessionId);
    } catch (error) {
      const message = errorMessage(error);
      console.error('[topology] learning finalize failed', sessionId, message);
      await this.pool.query(
        `UPDATE topology_learning_sessions
         SET status = 'failed', error = $3, completed_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, sessionId, message],
      ).catch(() => undefined);
      // 「没有已归属主机」需要让路由返回 409，而不是只落一个 failed 会话。
      if (error instanceof TopologyLearningError && error.code === 'no_managed_hosts') throw error;
      return this.getSession(tenantId, sessionId);
    }
  }

  /** 读取会话窗口内的样本 + 主机/清单/应用系统/异常，组装分析器输入。 */
  private async collectInput(session: TopologyLearningSession): Promise<TopologyLearningInput> {
    const tenantId = session.tenantId;
    const appSystemId = session.scope.kind === 'app-system' ? session.scope.appSystemId ?? null : null;
    const agentsResult = await this.pool.query<{
      id: string;
      hostname: string;
      status: string;
      system_info: Record<string, unknown>;
      app_system_id: string | null;
      app_system_name: string | null;
    }>(
      `SELECT a.id, a.hostname, a.status, a.system_info, a.app_system_id, s.name AS app_system_name
       FROM agents a LEFT JOIN app_systems s ON s.id = a.app_system_id
       WHERE a.tenant_id = $1`,
      [tenantId],
    );
    const agents: LearningAgentSource[] = agentsResult.rows.map((row) => ({
      id: row.id,
      hostname: row.hostname,
      status: row.status,
      systemInfo: row.system_info,
      appSystemId: row.app_system_id,
      appSystemName: row.app_system_name ?? '',
    }));
    const scopeAgentIds = appSystemId
      ? agents.filter((agent) => agent.appSystemId === appSystemId).map((agent) => agent.id)
      : [];
    if (appSystemId && scopeAgentIds.length === 0) {
      // 默认排除未归属主机时，应用系统下没有主机等同「无纳管主机」，路由返回 409。
      if (!session.includeUnassigned) throw new TopologyLearningError('no_managed_hosts');
      // 显式包含未归属主机时仍产出空图，让页面有明确空态。
      return buildLearningInput({
        scope: session.scope,
        windowStart: new Date(session.startedAt),
        windowEnd: new Date(session.endsAt),
        agents: [],
        inventory: [],
        edges: [],
        includeUnassigned: true,
      });
    }
    const inventoryResult = await this.pool.query<{
      agent_id: string;
      kind: string;
      name: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT agent_id, kind, name, detail FROM agent_inventory
       WHERE tenant_id = $1 AND kind IN ('process', 'port')`,
      [tenantId],
    );
    const inventory: LearningInventorySource[] = inventoryResult.rows.map((row) => ({
      agentId: row.agent_id,
      kind: row.kind,
      name: row.name,
      detail: row.detail,
    }));
    const edgeParams: unknown[] = [tenantId, session.endsAt, session.startedAt];
    let scopeClause = '';
    if (appSystemId) {
      scopeClause = 'AND agent_id = ANY($4::uuid[])';
      edgeParams.push(scopeAgentIds);
    }
    const edgeResult = await this.pool.query<{
      agent_id: string;
      direction: string;
      process: string;
      pid: number;
      service: string;
      command: string;
      local_address: string;
      local_port: number;
      peer_address: string;
      peer_port: number;
      protocol: string;
      opened: number;
      closed: number;
      failed: number;
      active: number;
      last_seen: Date | null;
    }>(
      `SELECT agent_id, direction, process, pid, service, command, local_address, local_port,
              peer_address, peer_port, protocol, opened, closed, failed, active, last_seen
       FROM agent_connection_edges
       WHERE tenant_id = $1 AND window_start < $2 AND window_end > $3 ${scopeClause}
       ORDER BY opened DESC, active DESC LIMIT 20000`,
      edgeParams,
    );
    const edges: LearningEdgeSource[] = edgeResult.rows.map((row) => ({
      agentId: row.agent_id,
      direction: row.direction,
      process: row.process,
      pid: row.pid,
      service: row.service,
      command: row.command,
      localAddress: row.local_address,
      localPort: row.local_port,
      peerAddress: row.peer_address,
      peerPort: row.peer_port,
      protocol: row.protocol,
      opened: row.opened,
      closed: row.closed,
      failed: row.failed,
      active: row.active,
      lastSeen: row.last_seen ? row.last_seen.toISOString() : null,
    }));
    const anomalies = await this.collectAnomalies(tenantId, appSystemId ? scopeAgentIds : agents.map((agent) => agent.id));
    const input = buildLearningInput({
      scope: session.scope,
      windowStart: new Date(session.startedAt),
      windowEnd: new Date(session.endsAt),
      agents,
      inventory,
      edges,
      anomalies,
      includeUnassigned: session.includeUnassigned,
    });
    if (!session.includeUnassigned && input.hosts.length === 0) {
      throw new TopologyLearningError('no_managed_hosts');
    }
    return input;
  }

  private async collectAnomalies(
    tenantId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (agentIds.length === 0) return map;
    try {
      const result = await this.pool.query<{ agent_id: string; title: string; severity: string }>(
        `SELECT agent_id, title, severity FROM agent_events
         WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[]) AND status = 'open'
         ORDER BY detected_at DESC LIMIT 200`,
        [tenantId, agentIds],
      );
      for (const row of result.rows) {
        const list = map.get(row.agent_id) ?? [];
        if (list.length < 10) list.push(`${row.severity}: ${row.title}`.slice(0, 200));
        map.set(row.agent_id, list);
      }
    } catch (error) {
      console.warn('[topology] load anomalies failed', error);
    }
    return map;
  }

  /** 分析器实例（测试可注入桩，默认使用 LLM/启发式分析器）。 */
  private resolveAnalyzer(): TopologyAnalyzerLike {
    if (!this.analyzerInstance) this.analyzerInstance = new TopologyAnalyzer(this.completion);
    return this.analyzerInstance;
  }

  /** 当前租户生效的模型名；未配置返回 null（分析器走启发式兜底）。 */
  private async resolveModelLabel(tenantId: string): Promise<string | null> {
    try {
      const model = await this.models.resolve(tenantId);
      const label = model?.model?.trim() ?? '';
      return label || null;
    } catch {
      return null;
    }
  }

  /** 对 ready/failed 会话按原窗口重新分析，生成新版本图。 */
  async analyzeAgain(tenantId: string, sessionId: string): Promise<TopologyLearningSession | null> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) throw new TopologyLearningError('session_not_found');
    if (session.status !== 'ready' && session.status !== 'failed') {
      throw new TopologyLearningError('session_not_ready');
    }
    return this.finalize(tenantId, sessionId);
  }

  /** 取消进行中的学习会话。 */
  async cancel(tenantId: string, sessionId: string): Promise<TopologyLearningSession | null> {
    const session = await this.getSession(tenantId, sessionId);
    if (!session) return null;
    if (!['collecting', 'aggregating', 'analyzing'].includes(session.status)) {
      throw new TopologyLearningError('session_not_cancellable');
    }
    await this.pool.query(
      `UPDATE topology_learning_sessions
       SET status = 'cancelled', completed_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status IN ('collecting', 'aggregating', 'analyzing')`,
      [tenantId, sessionId],
    );
    return this.getSession(tenantId, sessionId);
  }

  /** 拓扑图版本列表（新→旧）。 */
  async list(tenantId: string, limit = 20): Promise<TopologyGraphSummary[]> {
    const size = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 20;
    const result = await this.pool.query<{
      id: string;
      tenant_id: string;
      session_id: string;
      scope_kind: 'tenant' | 'app-system';
      app_system_id: string | null;
      mode: 'host' | 'app-system';
      version: number;
      window_start: Date;
      window_end: Date;
      window_seconds: number;
      analysis: unknown;
      stats: unknown;
      model: string;
      fallback: boolean;
      created_at: Date;
      app_system_name: string | null;
    }>(
      `SELECT g.id, g.tenant_id, g.session_id, g.scope_kind, g.app_system_id, g.mode, g.version,
              g.window_start, g.window_end, g.window_seconds,
              g.analysis, g.stats, g.model, g.prompt_version, g.fallback, g.created_at,
              a.name AS app_system_name
       FROM topology_graphs g LEFT JOIN app_systems a ON a.id = g.app_system_id
       WHERE g.tenant_id = $1
       ORDER BY g.created_at DESC, g.version DESC LIMIT $2`,
      [tenantId, size],
    );
    return result.rows.map((row) => {
      const analysis = asRecord(row.analysis);
      const stats = statsFromValue(row.stats);
      return {
        id: row.id,
        sessionId: row.session_id,
        scope: scopeFromColumns(row.scope_kind, row.app_system_id, row.app_system_name),
        mode: row.mode,
        window: {
          start: iso(row.window_start),
          end: iso(row.window_end),
          seconds: row.window_seconds,
        },
        nodeCount: stats?.nodeCount ?? 0,
        edgeCount: stats?.edgeCount ?? 0,
        totalConnections: stats?.totalConnections ?? 0,
        failedConnections: stats?.failedConnections ?? 0,
        model: row.model || text(analysis.model, 120),
        fallback: row.fallback,
        createdAt: iso(row.created_at),
        version: row.version,
        summary: text(analysis.summary, 500),
      };
    });
  }

  /** 最新拓扑图，可按应用系统过滤。 */
  async latest(tenantId: string, appSystemId?: string | null): Promise<TopologyGraph | null> {
    const result = await this.pool.query<GraphRow>(
      `${GRAPH_SELECT}
       WHERE g.tenant_id = $1 AND ($2::uuid IS NULL OR g.app_system_id = $2)
       ORDER BY g.created_at DESC, g.version DESC LIMIT 1`,
      [tenantId, appSystemId ?? null],
    );
    const row = result.rows[0];
    if (!row) return null;
    const graph = graphFromRow(row);
    return attachEdgeTags(graph, await this.edgeTags.list(tenantId));
  }

  /** 按 id 读取完整拓扑图。 */
  async get(tenantId: string, graphId: string): Promise<TopologyGraph | null> {
    const result = await this.pool.query<GraphRow>(
      `${GRAPH_SELECT} WHERE g.tenant_id = $1 AND g.id = $2`,
      [tenantId, graphId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const graph = graphFromRow(row);
    return attachEdgeTags(graph, await this.edgeTags.list(tenantId));
  }

  /** 自动学习策略（未配置时返回默认关闭策略）。 */
  async getPolicy(tenantId: string): Promise<TopologyLearningPolicy> {
    const result = await this.pool.query<PolicyRow>(
      `${POLICY_SELECT} WHERE p.tenant_id = $1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row) return policyFromRow(row);
    return {
      tenantId,
      enabled: false,
      intervalSeconds: 21_600,
      windowSeconds: TOPOLOGY_WINDOW_DEFAULT_SECONDS,
      scope: { kind: 'tenant', appSystemId: null },
      includeUnassigned: false,
      lastRunAt: null,
      nextRunAt: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 更新自动学习策略：interval 600~86400、window 60~1800、scope 校验归属。 */
  async updatePolicy(
    tenantId: string,
    input: {
      readonly enabled?: boolean;
      readonly intervalSeconds?: number;
      readonly windowSeconds?: number;
      readonly scope?: TopologyScope;
      readonly includeUnassigned?: boolean;
    },
  ): Promise<TopologyLearningPolicy> {
    const current = await this.getPolicy(tenantId);
    const enabled = input.enabled ?? current.enabled;
    const intervalSeconds = input.intervalSeconds ?? current.intervalSeconds;
    const windowSeconds = input.windowSeconds ?? current.windowSeconds;
    const includeUnassigned = input.includeUnassigned ?? current.includeUnassigned;
    if (!Number.isInteger(intervalSeconds)
      || intervalSeconds < TOPOLOGY_POLICY_MIN_INTERVAL_SECONDS
      || intervalSeconds > TOPOLOGY_POLICY_MAX_INTERVAL_SECONDS) {
      throw new TopologyLearningError('invalid_interval');
    }
    if (!Number.isInteger(windowSeconds)
      || windowSeconds < TOPOLOGY_WINDOW_MIN_SECONDS
      || windowSeconds > TOPOLOGY_WINDOW_MAX_SECONDS) {
      throw new TopologyLearningError('invalid_window');
    }
    let scope: TopologyScope;
    if (input.scope) {
      if (input.scope.kind !== 'tenant' && input.scope.kind !== 'app-system') {
        throw new TopologyLearningError('invalid_scope');
      }
      const requested = input.scope.kind === 'app-system' ? input.scope.appSystemId ?? null : null;
      if (input.scope.kind === 'app-system' && !requested) throw new TopologyLearningError('invalid_scope');
      scope = await this.resolveScope(tenantId, requested);
    } else {
      scope = current.scope.kind === 'app-system' && current.scope.appSystemId
        ? await this.resolveScope(tenantId, current.scope.appSystemId)
        : { kind: 'tenant', appSystemId: null };
    }
    const nextRunAt = enabled ? new Date(Date.now() + intervalSeconds * 1000) : null;
    const result = await this.pool.query<PolicyRow>(
      `WITH upserted AS (
         INSERT INTO topology_learning_policies
           (tenant_id, enabled, interval_seconds, window_seconds, scope_kind, app_system_id,
            include_unassigned, last_run_at, next_run_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           interval_seconds = EXCLUDED.interval_seconds,
           window_seconds = EXCLUDED.window_seconds,
           scope_kind = EXCLUDED.scope_kind,
           app_system_id = EXCLUDED.app_system_id,
           include_unassigned = EXCLUDED.include_unassigned,
           last_run_at = EXCLUDED.last_run_at,
           next_run_at = EXCLUDED.next_run_at,
           updated_at = now()
         RETURNING *
       )
       SELECT u.*, a.name AS app_system_name
       FROM upserted u LEFT JOIN app_systems a ON a.id = u.app_system_id`,
      [
        tenantId,
        enabled,
        intervalSeconds,
        windowSeconds,
        scope.kind,
        scope.appSystemId ?? null,
        includeUnassigned,
        current.lastRunAt ?? null,
        nextRunAt,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new TopologyLearningError('policy_update_failed');
    return policyFromRow(row);
  }

  /** 清理过期窗口样本（默认 7 天），由调度器周期性调用。 */
  async purgeOldEdgeSamples(days = 7): Promise<number> {
    return new AgentConnectionEdgeService(this.pool).purgeOlderThan(days);
  }
}

const GRAPH_SELECT = `SELECT g.id, g.tenant_id, g.session_id, g.scope_kind, g.app_system_id, g.mode,
  g.version, g.window_start, g.window_end, g.window_seconds, g.nodes, g.edges, g.systems,
  g.analysis, g.stats, g.model, g.prompt_version, g.fallback, g.created_at,
  a.name AS app_system_name
  FROM topology_graphs g LEFT JOIN app_systems a ON a.id = g.app_system_id`;

const POLICY_SELECT = `SELECT p.tenant_id, p.enabled, p.interval_seconds, p.window_seconds,
  p.scope_kind, p.app_system_id, p.include_unassigned, p.last_run_at, p.next_run_at, p.updated_at,
  a.name AS app_system_name
  FROM topology_learning_policies p LEFT JOIN app_systems a ON a.id = p.app_system_id`;

/** 定时调度：会话状态推进 + 到期自动学习策略；环境变量 OPSAGENT_TOPOLOGY_AUTOLEARN=false 可关闭自动学习。 */
export class TopologyLearningScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastPurgeAt = 0;

  constructor(
    private readonly service: TopologyLearningService,
    private readonly intervalMs = Number.parseInt(process.env.OPSAGENT_TOPOLOGY_TICK_MS ?? '10000', 10) || 10_000,
    private readonly autoLearn = process.env.OPSAGENT_TOPOLOGY_AUTOLEARN !== 'false',
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<TopologyLearningTickResult> {
    if (this.running) {
      return { aggregated: 0, failed: 0, scheduled: 0 };
    }
    this.running = true;
    try {
      const result = await this.service.tick({ autoLearn: this.autoLearn });
      if (Date.now() - this.lastPurgeAt > 6 * 60 * 60 * 1000) {
        this.lastPurgeAt = Date.now();
        await this.service.purgeOldEdgeSamples(7).catch((error) => {
          console.warn('[topology] purge old edge samples failed', error);
        });
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
