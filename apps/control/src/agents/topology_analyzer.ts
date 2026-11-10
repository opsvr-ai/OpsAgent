/**
 * 拓扑分析器：把固定时间窗口内的真实建连关系整理成「一眼看懂」的业务访问拓扑。
 *
 * 数据流：
 *   TopologyLearningInput（控制面聚合后的本周窗口数据）
 *     → 大模型分析（严格 JSON）→ 校验/夹取/真实数字回填 → TopologyDraft
 *     → 模型不可用时：确定性启发式分层规则 → TopologyDraft（fallback）
 *     → TopologyAnalysis（summary / insights / hotPaths / risks / confidence）
 *
 * Prompt 结构（TOPOLOGY_PROMPT_VERSION = 'topology-v1'）：
 *   - system：资深 SRE 架构师角色 + 分层/引用/数值约束 + 严格 JSON schema + 小例子；
 *   - user  ：一句任务说明 + 一段紧凑的 TopologyLearningInput JSON
 *             （顶层字段：scope / window / stats / hosts / edges / externalPeers；
 *              hosts[].id / externalPeers[].id 是稳定短 id；
 *              edges[].from / edges[].to 引用这些 id）+「只输出 JSON」指令。
 *   这样本地 OpenAI 兼容 mock server 可以直接从 user JSON 里读出节点 id，回一份引用闭合的 draft。
 *
 * 兜底保证：任何模型错误（未配置/超时/HTTP/空响应/非 JSON/校验失败）都返回可渲染的
 * TopologyDraft：节点 id 引用闭合、tier/kind 合法、边端口 > 0、数量受控、insights 非空。
 */
import type {
  TopologyAnalysis,
  TopologyDraft,
  TopologyDraftEdge,
  TopologyDraftNode,
  TopologyGraphStats,
  TopologyHotPath,
  TopologyInsight,
  TopologyInsightSeverity,
  TopologyLearningEdge,
  TopologyLearningHost,
  TopologyLearningInput,
  TopologyNodeKind,
  TopologyNodeStatus,
  TopologyServicePort,
  TopologySystemGroup,
  TopologyTier,
} from '@opsagent/contracts';
import type { ModelCompletionService } from '../models/completion.js';

export const TOPOLOGY_PROMPT_VERSION = 'topology-v1';

/** 模型路径且拿不到真实模型名时的兜底标签。 */
export const DEFAULT_MODEL_LABEL = 'llm';

/** 模型不可用的统一 warning 文案（控制面与 Web 依赖这个文案做提示）。 */
export const TOPOLOGY_FALLBACK_WARNING = '模型不可用，已使用规则引擎生成';

const UNASSIGNED_SYSTEM_ID = '__unassigned__';
const UNASSIGNED_SYSTEM_NAME = '未归属';

const MAX_DRAFT_NODES = 120;
const MAX_DRAFT_EDGES = 240;
const MAX_INSIGHTS = 8;
const MAX_HOT_PATHS = 5;
const MAX_PROMPT_HOSTS = 80;
const MAX_PROMPT_EDGES = 120;
const MAX_PROMPT_PEERS = 30;
const MAX_HOT_PATH_NODES = 5;

const TIER_ORDER: Record<TopologyTier, number> = {
  ingress: 0,
  app: 1,
  middleware: 2,
  data: 3,
  external: 4,
  infra: 5,
};

const TIER_VALUES: readonly TopologyTier[] = ['ingress', 'app', 'middleware', 'data', 'external', 'infra'];
const KIND_VALUES: readonly TopologyNodeKind[] = [
  'gateway',
  'service',
  'database',
  'cache',
  'mq',
  'storage',
  'external',
  'unknown',
];
const SEVERITY_VALUES: readonly TopologyInsightSeverity[] = ['info', 'warning', 'critical'];
const STATUS_VALUES: readonly TopologyNodeStatus[] = ['online', 'offline', 'unknown'];

const INGRESS_PATTERN = /(nginx|haproxy|envoy|apache|httpd|traefik|gateway|kong|\bf5\b|\b(?:lb|alb|nlb)\b|lvs|openresty)/i;
const MIDDLEWARE_PATTERN = /(redis|memcached|pika|kafka|rabbitmq|rocketmq|activemq|pulsar|nacos|zookeeper|elasticsearch|opensearch|etcd|consul)/i;
const DATA_PATTERN = /(mysql|mariadb|postgres|postgresql|oracle|sqlserver|mssql|mongodb|mongo|clickhouse|tidb|dameng|kingbase|dm8)/i;

export interface AnalyzeTopologyOptions {
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly modelLabel?: string;
}

export interface TopologyAnalysisResult {
  readonly draft: TopologyDraft;
  readonly analysis: TopologyAnalysis;
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.floor(clampNumber(value, min, max));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  }
  return null;
}

function positiveInt(value: unknown, max = 65_535): number | null {
  const parsed = toInt(value);
  if (parsed === null || parsed < 1 || parsed > max) return null;
  return parsed;
}

function nonNegativeInt(value: unknown): number | null {
  const parsed = toInt(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function cut(value: string, max: number): string {
  if (max <= 0) return '';
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function text(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? cut(trimmed, max) : fallback;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) result.push(trimmed);
  }
  return result;
}

/**
 * 构造对象时按需保留字段：exactOptionalPropertyTypes 下不能显式写 `field: undefined`。
 */
function defined<T>(source: Record<string, unknown>): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) output[key] = value;
  }
  return output as T;
}

function isTier(value: unknown): value is TopologyTier {
  return typeof value === 'string' && (TIER_VALUES as readonly string[]).includes(value);
}

function isKind(value: unknown): value is TopologyNodeKind {
  return typeof value === 'string' && (KIND_VALUES as readonly string[]).includes(value);
}

function isSeverity(value: unknown): value is TopologyInsightSeverity {
  return typeof value === 'string' && (SEVERITY_VALUES as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is TopologyNodeStatus {
  return typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value);
}

function normalizeAddress(value: string): string {
  const trimmed = (value.split('%')[0] ?? value).trim().toLowerCase();
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

function isLoopback(value: string): boolean {
  const address = normalizeAddress(value);
  return (
    address === '' ||
    address === '::1' ||
    address === '::' ||
    address === '0.0.0.0' ||
    address === 'localhost' ||
    address.startsWith('127.')
  );
}

function mapHostStatus(status: string): TopologyNodeStatus {
  const value = status.trim().toLowerCase();
  if (['online', 'active', 'connected', 'healthy', 'ok', 'running'].includes(value)) return 'online';
  if (['offline', 'disconnected', 'inactive', 'down', 'unreachable', 'error', 'failed'].includes(value)) return 'offline';
  return 'unknown';
}

function edgeKey(source: string, target: string, port: number): string {
  return `${source}\u0000${target}\u0000${port}`;
}

/**
 * Draft 边没有 id：用 `e:source->target:port` 作为稳定身份（hotPaths.edgeIds / insights.edgeIds 同口径）。
 *
 * 该格式与控制面 `buildGraphPayload` 落的 `TopologyEdge.id`（`e:${source}->${target}:${port}`）一致，
 * 否则 hotPaths.edgeIds 会在落库归一化时被过滤掉。
 */
export function topologyEdgeId(edge: Pick<TopologyDraftEdge, 'source' | 'target' | 'port'>): string {
  return `e:${edge.source}->${edge.target}:${edge.port}`;
}

function greaterText(a: string, b: string): string {
  return a > b ? a : b;
}

function combineDirection(
  a: 'out' | 'in' | 'both',
  b: 'out' | 'in' | 'both',
): 'out' | 'in' | 'both' {
  if (a === b) return a;
  return 'both';
}

// ---------------------------------------------------------------------------
// 主机会话分类（启发式，确定性）
// ---------------------------------------------------------------------------

export interface HostClassification {
  readonly tier: TopologyTier;
  readonly kind: TopologyNodeKind;
}

function hostServiceText(host: Pick<TopologyLearningHost, 'services'>): string {
  const parts: string[] = [];
  for (const service of host.services) {
    if (service.name) parts.push(service.name);
    if (service.process) parts.push(service.process);
  }
  return parts.join(' ').toLowerCase();
}

function middlewareKind(serviceText: string): TopologyNodeKind {
  if (/(redis|memcached|pika)/i.test(serviceText)) return 'cache';
  if (/(kafka|rabbitmq|rocketmq|activemq|pulsar)/i.test(serviceText)) return 'mq';
  if (/(elasticsearch|opensearch|minio|ceph|hdfs)/i.test(serviceText)) return 'storage';
  return 'service';
}

/**
 * 按「接入 → 中间件 → 数据 → 应用 → 基础设施」的优先级给纳管主机分层。
 *
 * - ingress：进程/服务名命中网关关键词，或监听 80/443 且被其他主机访问；
 * - middleware：redis/kafka/nacos/elasticsearch 等；
 * - data：mysql/postgres/oracle/mongodb 等；
 * - infra：无监听服务且无任何访问关系的纳管主机；
 * - app：其余纳管主机。
 */
export function classifyManagedHost(
  host: Pick<TopologyLearningHost, 'services'>,
  connections: { readonly inbound: number; readonly total: number },
): HostClassification {
  const serviceText = hostServiceText(host);
  const listensOnPublicPort = host.services.some((service) => service.port === 80 || service.port === 443);
  if (INGRESS_PATTERN.test(serviceText) || (listensOnPublicPort && connections.inbound > 0)) {
    return { tier: 'ingress', kind: 'gateway' };
  }
  if (MIDDLEWARE_PATTERN.test(serviceText)) {
    return { tier: 'middleware', kind: middlewareKind(serviceText) };
  }
  if (DATA_PATTERN.test(serviceText)) {
    return { tier: 'data', kind: 'database' };
  }
  if (host.services.length === 0 && connections.total === 0) {
    return { tier: 'infra', kind: 'unknown' };
  }
  return { tier: 'app', kind: 'service' };
}

// ---------------------------------------------------------------------------
// 输入索引：稳定短 id、边解析、外部依赖聚合
// ---------------------------------------------------------------------------

interface ManagedHost {
  id: string;
  agentId: string;
  hostname: string;
  ip: string;
  appSystemId: string | null;
  appSystemName: string;
  status: string;
  services: TopologyServicePort[];
  anomalies: string[];
  synthetic: boolean;
}

interface ExternalAggregate {
  id: string;
  ip: string;
  ports: Set<number>;
  processes: Set<string>;
  services: Map<number, TopologyServicePort>;
  opened: number;
  failed: number;
  fromEdge: boolean;
}

interface ResolvedEdge {
  source: string;
  target: string;
  port: number;
  opened: number;
  closed: number;
  failed: number;
  active: number;
  protocol: string;
  direction: 'out' | 'in' | 'both';
  fromService: string;
  toService: string;
  external: boolean;
  lastSeen: string;
}

interface TopologyIndex {
  readonly managedHosts: ManagedHost[];
  readonly managedById: Map<string, ManagedHost>;
  readonly externalNodes: ExternalAggregate[];
  readonly externalById: Map<string, ExternalAggregate>;
  readonly edges: ResolvedEdge[];
  /** (source,target,port) → 合并后的真实输入边，用于模型边回填真实数字。 */
  readonly inputEdgeByKey: Map<string, ResolvedEdge>;
  readonly inboundByNode: Map<string, number>;
  readonly outboundByNode: Map<string, number>;
  readonly idByLower: Map<string, string>;
  readonly skippedEdges: number;
  readonly selfLoops: number;
}

function hostBaseId(agentId: string, hostname: string): string {
  const raw = (agentId || hostname).trim();
  const compact = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  return `h:${compact.slice(0, 8) || 'host'}`;
}

function externalBaseId(key: string): string {
  const safe = key.trim().toLowerCase().replace(/[^a-z0-9.:_-]/g, '-');
  return `x:${safe.slice(0, 60) || 'unknown'}`;
}

function normalizeServices(services: readonly TopologyServicePort[] | undefined): TopologyServicePort[] {
  const byPort = new Map<number, TopologyServicePort>();
  for (const service of services ?? []) {
    const port = positiveInt(service.port);
    if (port === null || byPort.has(port)) continue;
    const name = text(service.name, 80);
    if (!name) continue;
    const process = text(service.process, 80);
    const pid = nonNegativeInt(service.pid);
    byPort.set(port, defined<TopologyServicePort>({ name, port, process: process || undefined, pid: pid ?? undefined }));
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function resolveEdgePort(edge: TopologyLearningEdge, targetHost: ManagedHost | null): number | null {
  const direct = positiveInt(edge.toPort);
  if (direct !== null) return direct;
  const numericService = Number.parseInt((edge.toService ?? '').trim(), 10);
  if (Number.isInteger(numericService) && numericService > 0 && numericService <= 65_535) {
    return numericService;
  }
  if (!targetHost) return null;
  const wanted = (edge.toService ?? '').trim().toLowerCase();
  if (!wanted) return null;
  for (const service of targetHost.services) {
    if (service.name.toLowerCase() === wanted) return service.port;
    if ((service.process ?? '').toLowerCase() === wanted) return service.port;
  }
  return null;
}

function mergeResolvedEdge(target: ResolvedEdge, candidate: ResolvedEdge): void {
  target.opened += candidate.opened;
  target.closed += candidate.closed;
  target.failed += candidate.failed;
  target.active += candidate.active;
  target.protocol = target.protocol || candidate.protocol;
  target.fromService = target.fromService || candidate.fromService;
  target.toService = target.toService || candidate.toService;
  target.lastSeen = greaterText(target.lastSeen, candidate.lastSeen);
  target.direction = combineDirection(target.direction, candidate.direction);
}

function maxZero(value: unknown): number {
  const parsed = toInt(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

function buildTopologyIndex(input: TopologyLearningInput): TopologyIndex {
  const usedIds = new Set<string>();
  const managedHosts: ManagedHost[] = [];
  const managedById = new Map<string, ManagedHost>();
  const managedByAgentId = new Map<string, ManagedHost>();
  const managedByHostname = new Map<string, ManagedHost>();
  const managedByIp = new Map<string, ManagedHost>();
  const seenHostKeys = new Set<string>();

  const uniqueId = (base: string): string => {
    const safeBase = base || 'node';
    let candidate = safeBase;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${safeBase}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  };

  const registerHost = (host: ManagedHost): void => {
    managedHosts.push(host);
    managedById.set(host.id, host);
    if (host.agentId && !managedByAgentId.has(host.agentId)) managedByAgentId.set(host.agentId, host);
    if (host.hostname && !managedByHostname.has(host.hostname.toLowerCase())) {
      managedByHostname.set(host.hostname.toLowerCase(), host);
    }
    const normalizedIp = normalizeAddress(host.ip);
    if (normalizedIp && !managedByIp.has(normalizedIp)) managedByIp.set(normalizedIp, host);
  };

  for (const host of input.hosts) {
    const agentId = (host.agentId ?? '').trim();
    const hostname = (host.hostname ?? '').trim();
    const ip = (host.ip ?? '').trim();
    const dedupeKey = agentId ? `agent:${agentId}` : `host:${hostname.toLowerCase()}|${normalizeAddress(ip)}`;
    if (seenHostKeys.has(dedupeKey)) continue;
    seenHostKeys.add(dedupeKey);
    registerHost({
      id: uniqueId(hostBaseId(agentId, hostname)),
      agentId,
      hostname,
      ip,
      appSystemId:
        typeof host.appSystemId === 'string' && host.appSystemId.trim() ? host.appSystemId.trim() : null,
      appSystemName: (host.appSystemName ?? '').trim(),
      status: (host.status ?? '').trim(),
      services: normalizeServices(host.services),
      anomalies: (host.anomalies ?? [])
        .filter((anomaly): anomaly is string => typeof anomaly === 'string' && anomaly.trim().length > 0)
        .map((anomaly) => cut(anomaly.trim(), 200))
        .slice(0, 8),
      synthetic: false,
    });
  }

  const externalNodes: ExternalAggregate[] = [];
  const externalByKey = new Map<string, ExternalAggregate>();
  const externalById = new Map<string, ExternalAggregate>();

  const ensureExternal = (key: string): ExternalAggregate | null => {
    const display = key.trim();
    if (!display) return null;
    const normalized = normalizeAddress(display) || display.toLowerCase();
    if (managedByIp.has(normalized)) return null;
    const existing = externalByKey.get(normalized);
    if (existing) return existing;
    const aggregate: ExternalAggregate = {
      id: uniqueId(externalBaseId(display)),
      ip: display,
      ports: new Set<number>(),
      processes: new Set<string>(),
      services: new Map<number, TopologyServicePort>(),
      opened: 0,
      failed: 0,
      fromEdge: false,
    };
    externalByKey.set(normalized, aggregate);
    externalNodes.push(aggregate);
    externalById.set(aggregate.id, aggregate);
    return aggregate;
  };

  for (const peer of input.externalPeers) {
    const ip = (peer.ip ?? '').trim();
    if (!ip || isLoopback(ip)) continue;
    const aggregate = ensureExternal(ip);
    if (!aggregate) continue;
    const port = positiveInt(peer.port);
    if (port !== null) {
      aggregate.ports.add(port);
      if (!aggregate.services.has(port)) {
        aggregate.services.set(port, { name: `tcp/${port}`, port });
      }
    }
    for (const process of peer.processes ?? []) {
      const name = text(process, 80);
      if (name) aggregate.processes.add(name);
    }
    aggregate.opened += maxZero(peer.opened);
    aggregate.failed += maxZero(peer.failed);
  }

  const syntheticByKey = new Map<string, ManagedHost>();
  const ensureSyntheticHost = (
    agentId: string,
    hostname: string,
    ip: string,
    appSystemId: string | null | undefined,
    appSystemName: string | undefined,
  ): ManagedHost => {
    const key = agentId ? `agent:${agentId}` : `host:${hostname.toLowerCase()}|${normalizeAddress(ip)}`;
    const existing = syntheticByKey.get(key);
    if (existing) return existing;
    const synthetic: ManagedHost = {
      id: uniqueId(hostBaseId(agentId, hostname)),
      agentId,
      hostname,
      ip,
      appSystemId:
        typeof appSystemId === 'string' && appSystemId.trim() ? appSystemId.trim() : null,
      appSystemName: (appSystemName ?? '').trim(),
      status: 'unknown',
      services: [],
      anomalies: [],
      synthetic: true,
    };
    syntheticByKey.set(key, synthetic);
    registerHost(synthetic);
    return synthetic;
  };

  const addSyntheticService = (host: ManagedHost, port: number, serviceName: string): void => {
    if (host.services.some((service) => service.port === port)) return;
    const name = text(serviceName, 80) || `tcp/${port}`;
    host.services.push({ name, port });
    host.services.sort((a, b) => a.port - b.port);
  };

  const mergedEdges = new Map<string, ResolvedEdge>();
  let skippedEdges = 0;
  let selfLoops = 0;

  for (const edge of input.edges) {
    const fromAgentId = (edge.fromAgentId ?? '').trim();
    const fromHostname = (edge.fromHost ?? '').trim();
    let sourceHost = fromAgentId ? managedByAgentId.get(fromAgentId) : undefined;
    if (!sourceHost && fromHostname) sourceHost = managedByHostname.get(fromHostname.toLowerCase());
    if (!sourceHost) {
      if (!fromAgentId && !fromHostname) {
        skippedEdges += 1;
        continue;
      }
      sourceHost = ensureSyntheticHost(fromAgentId, fromHostname, '', null, '');
    }

    const toAgentId = (edge.toAgentId ?? '').trim();
    const toHostname = (edge.toHost ?? '').trim();
    const toIp = (edge.toIp ?? '').trim();
    let targetHost = toAgentId ? managedByAgentId.get(toAgentId) : undefined;
    if (!targetHost && toHostname) targetHost = managedByHostname.get(toHostname.toLowerCase());
    if (!targetHost && toIp) targetHost = managedByIp.get(normalizeAddress(toIp));

    const port = resolveEdgePort(edge, targetHost ?? null);
    if (port === null) {
      skippedEdges += 1;
      continue;
    }

    let targetId: string;
    let targetExternal: ExternalAggregate | null = null;
    if (targetHost) {
      targetId = targetHost.id;
      if (targetHost.synthetic) addSyntheticService(targetHost, port, edge.toService);
    } else if (toAgentId) {
      targetHost = ensureSyntheticHost(toAgentId, toHostname, toIp, edge.targetAppSystemId, edge.targetAppSystemName);
      addSyntheticService(targetHost, port, edge.toService);
      targetId = targetHost.id;
    } else {
      const key = toIp || toHostname;
      if (!key || isLoopback(key)) {
        skippedEdges += 1;
        continue;
      }
      targetExternal = ensureExternal(key);
      if (!targetExternal) {
        skippedEdges += 1;
        continue;
      }
      targetExternal.fromEdge = true;
      targetExternal.ports.add(port);
      if (!targetExternal.services.has(port)) {
        targetExternal.services.set(port, {
          name: text(edge.toService, 80) || `tcp/${port}`,
          port,
        });
      }
      targetId = targetExternal.id;
    }

    if (sourceHost.id === targetId) {
      selfLoops += 1;
      continue;
    }

    const direction: 'out' | 'in' | 'both' =
      edge.direction === 'in' || edge.direction === 'both' ? edge.direction : 'out';
    const resolved: ResolvedEdge = {
      source: sourceHost.id,
      target: targetId,
      port,
      opened: maxZero(edge.opened),
      closed: maxZero(edge.closed),
      failed: maxZero(edge.failed),
      active: maxZero(edge.active),
      protocol: text(edge.protocol, 20) || 'tcp',
      direction,
      fromService: text(edge.fromService, 80),
      toService: text(edge.toService, 80),
      external: targetExternal !== null,
      lastSeen: text(edge.lastSeen, 40),
    };
    const key = edgeKey(resolved.source, resolved.target, resolved.port);
    const existing = mergedEdges.get(key);
    if (existing) mergeResolvedEdge(existing, resolved);
    else mergedEdges.set(key, resolved);
  }

  const inboundByNode = new Map<string, number>();
  const outboundByNode = new Map<string, number>();
  for (const edge of mergedEdges.values()) {
    const volume = Math.max(edge.opened, edge.active, 1);
    inboundByNode.set(edge.target, (inboundByNode.get(edge.target) ?? 0) + volume);
    outboundByNode.set(edge.source, (outboundByNode.get(edge.source) ?? 0) + volume);
  }

  const idByLower = new Map<string, string>();
  for (const host of managedHosts) idByLower.set(host.id.toLowerCase(), host.id);
  for (const external of externalNodes) idByLower.set(external.id.toLowerCase(), external.id);

  return {
    managedHosts,
    managedById,
    externalNodes,
    externalById,
    edges: [...mergedEdges.values()],
    inputEdgeByKey: new Map(mergedEdges),
    inboundByNode,
    outboundByNode,
    idByLower,
    skippedEdges,
    selfLoops,
  };
}

// ---------------------------------------------------------------------------
// 启发式：节点 / 边 / 业务系统 / 洞察 / 热点路径 / 摘要
// ---------------------------------------------------------------------------

function compareNode(a: TopologyDraftNode, b: TopologyDraftNode): number {
  const tierDelta = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  if (tierDelta !== 0) return tierDelta;
  return compareText(a.label, b.label) || compareText(a.id, b.id);
}

function sortNodes(nodes: readonly TopologyDraftNode[]): TopologyDraftNode[] {
  return [...nodes].sort(compareNode);
}

function compareEdgeEndpoints(a: TopologyDraftEdge, b: TopologyDraftEdge): number {
  return (
    compareText(a.source, b.source) ||
    compareText(a.target, b.target) ||
    a.port - b.port ||
    compareText(topologyEdgeId(a), topologyEdgeId(b))
  );
}

function buildHeuristicNodes(index: TopologyIndex): TopologyDraftNode[] {
  const nodes: TopologyDraftNode[] = [];
  for (const host of index.managedHosts) {
    const inbound = index.inboundByNode.get(host.id) ?? 0;
    const outbound = index.outboundByNode.get(host.id) ?? 0;
    const classification = classifyManagedHost(host, { inbound, total: inbound + outbound });
    const noteParts: string[] = [];
    if (host.synthetic) noteParts.push('未在主机清单中，由建连边推断');
    if (classification.tier === 'infra') noteParts.push('窗口内无监听服务且无访问关系');
    if (host.anomalies.length > 0) noteParts.push(`异常：${host.anomalies[0]}`);
    nodes.push(
      defined<TopologyDraftNode>({
        id: host.id,
        label: cut(host.hostname || host.ip || host.id, 80),
        kind: classification.kind,
        tier: classification.tier,
        hostname: cut(host.hostname || host.ip, 120) || undefined,
        ip: host.ip || undefined,
        appSystemId: host.appSystemId,
        appSystemName: host.appSystemName || undefined,
        status: mapHostStatus(host.status),
        services: host.services.slice(0, 24),
        inferred: host.synthetic,
        note: noteParts.length > 0 ? cut(noteParts.join('；'), 300) : undefined,
      }),
    );
  }
  for (const external of index.externalNodes) {
    const services = [...external.services.values()].sort((a, b) => a.port - b.port).slice(0, 24);
    nodes.push(
      defined<TopologyDraftNode>({
        id: external.id,
        label: cut(external.ip || external.id, 80),
        kind: 'external',
        tier: 'external',
        hostname: cut(external.ip, 120) || undefined,
        ip: external.ip || undefined,
        appSystemId: null,
        status: 'unknown',
        services,
        inferred: true,
        note: '未纳管外部依赖',
      }),
    );
  }
  return nodes;
}

function buildHeuristicEdges(index: TopologyIndex, nodeIds: ReadonlySet<string>): TopologyDraftEdge[] {
  const edges: TopologyDraftEdge[] = [];
  for (const edge of index.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const bidirectional =
      edge.direction === 'both' || index.inputEdgeByKey.has(edgeKey(edge.target, edge.source, edge.port));
    edges.push(
      defined<TopologyDraftEdge>({
        source: edge.source,
        target: edge.target,
        port: edge.port,
        count: Math.max(edge.opened, edge.active, 1),
        opened: edge.opened,
        failed: edge.failed,
        protocol: edge.protocol || 'tcp',
        label: text(edge.toService, 80) || undefined,
        confidence: bidirectional ? 0.9 : 0.85,
      }),
    );
  }
  return edges;
}

function buildSystems(nodes: readonly TopologyDraftNode[]): TopologySystemGroup[] {
  const groups = new Map<string, { name: string; nodeIds: string[] }>();
  for (const node of nodes) {
    const systemId = (node.appSystemId ?? '').trim();
    const key = systemId || UNASSIGNED_SYSTEM_ID;
    const candidateName =
      (node.appSystemName ?? '').trim() || (key === UNASSIGNED_SYSTEM_ID ? UNASSIGNED_SYSTEM_NAME : key);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { name: candidateName, nodeIds: [node.id] });
      continue;
    }
    if (existing.name === UNASSIGNED_SYSTEM_NAME && candidateName !== UNASSIGNED_SYSTEM_NAME) {
      existing.name = candidateName;
    }
    existing.nodeIds.push(node.id);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({ id, name: group.name, nodeIds: group.nodeIds }))
    .sort(
      (a, b) =>
        (a.id === UNASSIGNED_SYSTEM_ID ? 1 : 0) - (b.id === UNASSIGNED_SYSTEM_ID ? 1 : 0) ||
        compareText(a.name, b.name) ||
        compareText(a.id, b.id),
    );
}

function makeInsight(
  id: string,
  title: string,
  detail: string,
  severity: TopologyInsightSeverity,
  nodeIds: readonly string[] = [],
  edgeIds: readonly string[] = [],
): TopologyInsight {
  return defined<TopologyInsight>({
    id,
    title: cut(title, 120),
    detail: cut(detail, 600),
    severity,
    nodeIds: nodeIds.length > 0 ? [...nodeIds].slice(0, 8) : undefined,
    edgeIds: edgeIds.length > 0 ? [...edgeIds].slice(0, 8) : undefined,
  });
}

function filterInsightRefs(
  insight: TopologyInsight,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>,
): TopologyInsight {
  const keptNodeIds = (insight.nodeIds ?? []).filter((id) => nodeIds.has(id));
  const keptEdgeIds = (insight.edgeIds ?? []).filter((id) => edgeIds.has(id));
  return defined<TopologyInsight>({
    id: insight.id,
    title: insight.title,
    detail: insight.detail,
    severity: insight.severity,
    nodeIds: keptNodeIds.length > 0 ? keptNodeIds : undefined,
    edgeIds: keptEdgeIds.length > 0 ? keptEdgeIds : undefined,
  });
}

function capInsights(insights: readonly TopologyInsight[]): TopologyInsight[] {
  const seen = new Set<string>();
  const output: TopologyInsight[] = [];
  for (const insight of insights) {
    const baseId = insight.id.trim() || `insight-${output.length + 1}`;
    let uniqueId = baseId;
    let suffix = 2;
    while (seen.has(uniqueId)) {
      uniqueId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    seen.add(uniqueId);
    output.push(uniqueId === insight.id ? insight : { ...insight, id: uniqueId });
    if (output.length >= MAX_INSIGHTS) break;
  }
  return output;
}

function capHotPaths(hotPaths: readonly TopologyHotPath[]): TopologyHotPath[] {
  const seen = new Set<string>();
  const output: TopologyHotPath[] = [];
  for (const hotPath of hotPaths) {
    const signature = hotPath.nodeIds.join('>');
    if (seen.has(signature)) continue;
    seen.add(signature);
    output.push(hotPath);
    if (output.length >= MAX_HOT_PATHS) break;
  }
  return output;
}

/**
 * 模板化但引用真实数字的洞察。顺序：高频链路 → 高失败边 → 单点 → 跨系统 → 外部依赖 → 空闲主机。
 */
function buildHeuristicInsights(
  nodes: readonly TopologyDraftNode[],
  edges: readonly TopologyDraftEdge[],
  input: TopologyLearningInput,
): TopologyInsight[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const labelOf = (id: string): string => nodeById.get(id)?.label ?? id;
  const sortedEdges = [...edges].sort(
    (a, b) => b.count - a.count || compareText(topologyEdgeId(a), topologyEdgeId(b)),
  );

  // 1) 最高频链路 Top3
  const hotLinks: TopologyInsight[] = [];
  for (const [index, edge] of sortedEdges.slice(0, 3).entries()) {
    hotLinks.push(
      makeInsight(
        `hot-link-${index + 1}`,
        `高频访问：${labelOf(edge.source)} → ${labelOf(edge.target)}:${edge.port}`,
        `窗口内 ${labelOf(edge.source)} → ${labelOf(edge.target)}:${edge.port} 共 ${edge.count} 个连接（opened ${
          edge.opened ?? 0
        }、failed ${edge.failed ?? 0}）${edge.label ? `，目标服务 ${edge.label}` : ''}；这是当前窗口排名第 ${
          index + 1
        } 的访问链路，变更与扩容时优先关注。`,
        'info',
        [edge.source, edge.target],
        [topologyEdgeId(edge)],
      ),
    );
  }

  // 2) 高失败率 / 高失败次数边
  const failingEdges = [...edges]
    .filter((edge) => {
      const opened = Math.max(edge.opened ?? 0, 1);
      const failed = edge.failed ?? 0;
      return failed > 0 && (failed / opened > 0.2 || failed >= 20);
    })
    .sort((a, b) => (b.failed ?? 0) - (a.failed ?? 0) || compareText(topologyEdgeId(a), topologyEdgeId(b)))
    .slice(0, 2);
  const failureInsights = failingEdges.map((edge, index) => {
    const opened = Math.max(edge.opened ?? 0, 1);
    const failed = edge.failed ?? 0;
    const ratio = failed / opened;
    const severity: TopologyInsightSeverity = failed >= 50 || ratio >= 0.5 ? 'critical' : 'warning';
    return makeInsight(
      `edge-failure-${index + 1}`,
      `访问失败率偏高：${labelOf(edge.source)} → ${labelOf(edge.target)}:${edge.port}`,
      `窗口内该访问关系失败 ${failed} 次（opened ${edge.opened ?? 0} 次，约占 ${(ratio * 100).toFixed(
        1,
      )}%），共 ${edge.count} 个连接；高失败率通常意味着目标服务不可用、连接被拒绝或网络链路异常，建议检查目标服务健康、连接池与网络策略。`,
      severity,
      [edge.source, edge.target],
      [topologyEdgeId(edge)],
    );
  });

  // 3) 单点依赖：某业务系统的数据/中间件只有 1 个节点
  const systemGroups = new Map<string, { name: string; nodes: TopologyDraftNode[] }>();
  for (const node of nodes) {
    const systemId = (node.appSystemId ?? '').trim();
    if (!systemId) continue;
    const existing = systemGroups.get(systemId);
    if (existing) {
      existing.nodes.push(node);
      if (existing.name === systemId && node.appSystemName) existing.name = node.appSystemName;
    } else {
      systemGroups.set(systemId, {
        name: node.appSystemName || systemId,
        nodes: [node],
      });
    }
  }
  const sortedSystems = [...systemGroups.entries()].sort(
    (a, b) => compareText(a[1].name, b[1].name) || compareText(a[0], b[0]),
  );
  const singlePoints: TopologyInsight[] = [];
  sortedSystems.forEach(([, group], index) => {
    const criticalNodes = group.nodes.filter((node) => node.tier === 'data' || node.tier === 'middleware');
    const consumers = group.nodes.filter((node) => node.tier === 'app' || node.tier === 'ingress');
    if (criticalNodes.length !== 1 || consumers.length === 0) return;
    const node = criticalNodes[0];
    if (!node) return;
    const inboundConnections = edges
      .filter((edge) => edge.target === node.id)
      .reduce((sum, edge) => sum + edge.count, 0);
    singlePoints.push(
      makeInsight(
        `single-point-${index + 1}`,
        `业务系统「${group.name}」存在单点依赖`,
        `业务系统「${group.name}」的数据/中间件节点只有 ${node.label} 一个（${
          node.tier === 'data' ? '数据库' : '中间件'
        }），窗口内承接 ${inboundConnections} 个连接；该组件故障时 ${consumers.length} 个应用/接入节点会同时受影响，建议做主备或冗余部署。`,
        'warning',
        [node.id],
        [],
      ),
    );
  });

  // 4) 跨业务系统访问最多的系统对
  const systemNames = new Map<string, string>();
  for (const node of nodes) {
    const systemId = (node.appSystemId ?? '').trim();
    if (systemId && !systemNames.has(systemId)) systemNames.set(systemId, node.appSystemName || systemId);
  }
  const pairs = new Map<
    string,
    { readonly systemIds: [string, string]; connections: number; example: TopologyDraftEdge | null }
  >();
  for (const edge of edges) {
    const sourceSystem = nodeById.get(edge.source)?.appSystemId ?? null;
    const targetSystem = nodeById.get(edge.target)?.appSystemId ?? null;
    if (!sourceSystem || !targetSystem || sourceSystem === targetSystem) continue;
    const ordered: [string, string] = sourceSystem < targetSystem ? [sourceSystem, targetSystem] : [targetSystem, sourceSystem];
    const pairKey = ordered.join('\u0000');
    const existing = pairs.get(pairKey);
    if (existing) {
      existing.connections += edge.count;
      if (!existing.example || edge.count > existing.example.count) existing.example = edge;
    } else {
      pairs.set(pairKey, { systemIds: ordered, connections: edge.count, example: edge });
    }
  }
  const topPair = [...pairs.entries()].sort(
    (a, b) => b[1].connections - a[1].connections || compareText(a[0], b[0]),
  )[0];
  const crossSystemInsights: TopologyInsight[] = [];
  if (topPair) {
    const [, pair] = topPair;
    const [leftId, rightId] = pair.systemIds;
    const leftName = systemNames.get(leftId) ?? leftId;
    const rightName = systemNames.get(rightId) ?? rightId;
    const example = pair.example;
    const exampleText = example
      ? `${labelOf(example.source)} → ${labelOf(example.target)}:${example.port}（${example.count} 次）`
      : '多条跨系统链路';
    crossSystemInsights.push(
      makeInsight(
        'cross-system-1',
        `跨系统访问集中在「${leftName}」与「${rightName}」之间`,
        `「${leftName}」与「${rightName}」之间窗口内共 ${pair.connections} 个连接，是跨业务系统访问最多的一对；示例 ${exampleText}。跨系统依赖越多，变更与故障的级联影响面越大，建议梳理并收敛。`,
        'info',
        example ? [example.source, example.target] : [],
        example ? [topologyEdgeId(example)] : [],
      ),
    );
  }

  // 5) 未纳管外部依赖 Top2（实际输出 1 条，留 1 条给空间不足时的补位）
  const externalStats = new Map<
    string,
    { connections: number; opened: number; failed: number; ports: Set<number>; edgeIds: string[] }
  >();
  for (const edge of edges) {
    const target = nodeById.get(edge.target);
    if (!target || target.tier !== 'external') continue;
    const stats = externalStats.get(target.id) ?? {
      connections: 0,
      opened: 0,
      failed: 0,
      ports: new Set<number>(),
      edgeIds: [],
    };
    stats.connections += edge.count;
    stats.opened += edge.opened ?? 0;
    stats.failed += edge.failed ?? 0;
    stats.ports.add(edge.port);
    if (stats.edgeIds.length < 5) stats.edgeIds.push(topologyEdgeId(edge));
    externalStats.set(target.id, stats);
  }
  const externals = [...externalStats.entries()]
    .map(([nodeId, stats]) => ({ node: nodeById.get(nodeId), stats }))
    .filter((item): item is { node: TopologyDraftNode; stats: (typeof externalStats extends Map<string, infer V> ? V : never) } =>
      Boolean(item.node),
    )
    .sort((a, b) => b.stats.connections - a.stats.connections || compareText(a.node.label, b.node.label));
  const externalInsights = externals.slice(0, 2).map((item, index) => {
    const failed = item.stats.failed;
    const opened = Math.max(item.stats.opened, 1);
    const severity: TopologyInsightSeverity =
      failed > 0 && (failed / opened > 0.2 || failed >= 20) ? 'warning' : 'info';
    const ports = [...item.stats.ports].sort((a, b) => a - b).slice(0, 6).join('、');
    return makeInsight(
      `external-${index + 1}`,
      `未纳管外部依赖：${item.node.label}`,
      `未纳管外部依赖 ${item.node.label} 承接 ${item.stats.connections} 个连接（opened ${item.stats.opened}、failed ${failed}），涉及端口 ${
        ports || '未知'
      }；该依赖不在纳管范围内，平台无法感知其健康状态，建议补充探活、超时与告警。`,
      severity,
      [item.node.id],
      item.stats.edgeIds,
    );
  });

  // 6) 未被访问的纳管主机（可选项，空间不足时优先丢弃）
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  }
  const idleHosts = nodes.filter(
    (node) => node.tier !== 'external' && node.inferred !== true && !connectedIds.has(node.id),
  );
  const idleInsights: TopologyInsight[] = [];
  if (idleHosts.length > 0) {
    const names = idleHosts.slice(0, 8).map((node) => node.label).join('、');
    idleInsights.push(
      makeInsight(
        'idle-host-1',
        `${idleHosts.length} 台纳管主机窗口内无访问关系`,
        `窗口内 ${idleHosts.length} 台纳管主机没有观测到任何访问关系：${names}${
          idleHosts.length > 8 ? ' 等' : ''
        }；可能是空闲主机，或连接采集覆盖不足，建议确认用途或补充采集。`,
        'info',
        idleHosts.slice(0, 8).map((node) => node.id),
        [],
      ),
    );
  }

  // 保证信息广度：先覆盖 高频3 + 失败2 + 单点1 + 跨系统1 + 外部1，再补位。
  const primary: TopologyInsight[] = [
    ...hotLinks,
    ...failureInsights,
    ...singlePoints.slice(0, 1),
    ...crossSystemInsights,
    ...externalInsights.slice(0, 1),
  ];
  const extras: TopologyInsight[] = [...singlePoints.slice(1), ...externalInsights.slice(1), ...idleInsights];
  const insights: TopologyInsight[] = [];
  for (const insight of [...primary, ...extras]) {
    insights.push(insight);
    if (insights.length >= MAX_INSIGHTS) break;
  }
  if (insights.length === 0) {
    const hostCount = input.stats?.hostCount ?? nodes.length;
    insights.push(
      makeInsight(
        'insight-empty',
        '窗口内暂无有效访问关系',
        `窗口内 ${hostCount} 台纳管主机、0 条访问关系；未采集到有效建连数据，请确认 Agent 连接采集是否开启，或扩大学习时间窗口后重试。`,
        'info',
        [],
        [],
      ),
    );
  }
  return insights;
}

/** 从入口（ingress 或无入边节点）沿出边做受限 DFS，取总连接数最大的 3 条简单路径。 */
function buildHotPaths(
  nodes: readonly TopologyDraftNode[],
  edges: readonly TopologyDraftEdge[],
): TopologyHotPath[] {
  if (edges.length === 0) return [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, TopologyDraftEdge[]>();
  const inboundCount = new Map<string, number>();
  const outboundVolume = new Map<string, number>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
    inboundCount.set(edge.target, (inboundCount.get(edge.target) ?? 0) + 1);
    outboundVolume.set(edge.source, (outboundVolume.get(edge.source) ?? 0) + edge.count);
  }
  for (const list of outgoing.values()) {
    list.sort((a, b) => b.count - a.count || compareText(topologyEdgeId(a), topologyEdgeId(b)));
  }

  const entryCompare = (a: TopologyDraftNode, b: TopologyDraftNode): number =>
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
    (outboundVolume.get(b.id) ?? 0) - (outboundVolume.get(a.id) ?? 0) ||
    compareText(a.label, b.label) ||
    compareText(a.id, b.id);

  const entries = nodes
    .filter(
      (node) =>
        (outgoing.get(node.id)?.length ?? 0) > 0 &&
        (node.tier === 'ingress' || ((inboundCount.get(node.id) ?? 0) === 0 && node.tier !== 'external')),
    )
    .sort(entryCompare);
  const startNodes =
    entries.length > 0
      ? entries
      : nodes
          .filter((node) => (outgoing.get(node.id)?.length ?? 0) > 0)
          .sort((a, b) => (outboundVolume.get(b.id) ?? 0) - (outboundVolume.get(a.id) ?? 0));
  if (startNodes.length === 0) return [];

  interface Candidate {
    readonly nodeIds: string[];
    readonly edgeIds: string[];
    readonly connections: number;
  }
  const candidates: Candidate[] = [];
  const seenSignatures = new Set<string>();
  const walk = (current: string, pathNodes: string[], pathEdges: string[], connections: number): void => {
    if (candidates.length > 4000) return;
    const nextEdges = (outgoing.get(current) ?? [])
      .filter((edge) => !pathNodes.includes(edge.target))
      .slice(0, 4);
    for (const edge of nextEdges) {
      const nodeIds = [...pathNodes, edge.target];
      const edgeIds = [...pathEdges, topologyEdgeId(edge)];
      const total = connections + edge.count;
      const signature = nodeIds.join('\u0000');
      if (!seenSignatures.has(signature)) {
        seenSignatures.add(signature);
        candidates.push({ nodeIds, edgeIds, connections: total });
      }
      if (nodeIds.length < MAX_HOT_PATH_NODES) walk(edge.target, nodeIds, edgeIds, total);
    }
  };
  for (const entry of startNodes.slice(0, 8)) walk(entry.id, [entry.id], [], 0);

  return candidates
    .sort(
      (a, b) =>
        b.connections - a.connections ||
        compareText(a.nodeIds.join('>'), b.nodeIds.join('>')),
    )
    .slice(0, 3)
    .map((candidate) => ({
      label: cut(
        candidate.nodeIds.map((id) => nodeById.get(id)?.label ?? id).join(' → '),
        80,
      ),
      nodeIds: candidate.nodeIds,
      edgeIds: candidate.edgeIds,
      connections: candidate.connections,
    }));
}

function buildSummary(
  input: TopologyLearningInput,
  nodes: readonly TopologyDraftNode[],
  edges: readonly TopologyDraftEdge[],
  systems: readonly TopologySystemGroup[],
  risks: readonly TopologyInsight[],
  index: TopologyIndex,
): string {
  const statsHostCount = nonNegativeInt(input.stats?.hostCount) ?? 0;
  const hostCount = statsHostCount > 0 ? statsHostCount : index.managedHosts.length;
  const systemCount = systems.filter((system) => system.id !== UNASSIGNED_SYSTEM_ID).length;
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const topEdge = [...edges].sort(
    (a, b) => b.count - a.count || compareText(topologyEdgeId(a), topologyEdgeId(b)),
  )[0];
  const coreLink = topEdge
    ? `${labels.get(topEdge.source) ?? topEdge.source} → ${labels.get(topEdge.target) ?? topEdge.target}:${
        topEdge.port
      }（${topEdge.count} 次）`
    : '无显著访问关系';
  return `窗口内 ${hostCount} 台主机、${edges.length} 条访问关系、${systemCount} 个业务系统；核心链路 ${coreLink}；发现 ${risks.length} 个风险。`;
}

function computeHeuristicConfidence(
  nodes: readonly TopologyDraftNode[],
  edges: readonly TopologyDraftEdge[],
  systems: readonly TopologySystemGroup[],
): number {
  let confidence = 0.55;
  if (edges.length > 0) confidence += 0.03;
  if (systems.some((system) => system.id !== UNASSIGNED_SYSTEM_ID)) confidence += 0.03;
  if (nodes.some((node) => (node.services?.length ?? 0) > 0)) confidence += 0.02;
  if (nodes.some((node) => node.tier === 'ingress')) confidence += 0.02;
  return round2(clampNumber(confidence, 0.55, 0.65));
}

interface ModelParseStats {
  readonly matchedHosts: number;
  readonly matchedEdges: number;
  readonly droppedNodes: number;
  readonly droppedEdges: number;
}

const EMPTY_MODEL_STATS: ModelParseStats = {
  matchedHosts: 0,
  matchedEdges: 0,
  droppedNodes: 0,
  droppedEdges: 0,
};

function computeModelConfidence(
  stats: ModelParseStats,
  index: TopologyIndex,
  insights: readonly TopologyInsight[],
  hotPaths: readonly TopologyHotPath[],
  reportedConfidence: number,
): number {
  const totalHosts = index.managedHosts.length;
  const totalEdges = index.edges.length;
  const hostCoverage = totalHosts > 0 ? Math.min(1, stats.matchedHosts / totalHosts) : 1;
  const edgeCoverage = totalEdges > 0 ? Math.min(1, stats.matchedEdges / totalEdges) : 1;
  const completeness = (hostCoverage + edgeCoverage) / 2;
  const base = 0.75 + 0.1 * (0.6 * completeness + 0.4 * clampNumber(reportedConfidence, 0, 1));
  const bonus =
    (stats.droppedNodes === 0 && stats.droppedEdges === 0 ? 0.02 : 0) +
    (insights.length > 0 && hotPaths.length > 0 ? 0.02 : 0);
  return round2(clampNumber(base + bonus, 0.75, 0.9));
}

// ---------------------------------------------------------------------------
// 兜底图最终化：数量受控、引用闭合、补齐 systems / insights / hotPaths / summary / confidence
// ---------------------------------------------------------------------------

interface DraftSeed {
  nodes: TopologyDraftNode[];
  edges: TopologyDraftEdge[];
  insights: TopologyInsight[];
  hotPaths: TopologyHotPath[];
  risks: TopologyInsight[];
  summary: string;
}

interface FinalizeOptions {
  readonly mode: 'model' | 'heuristic';
  readonly modelStats: ModelParseStats;
  readonly reportedConfidence: number;
}

function dedupeNodes(nodes: readonly TopologyDraftNode[]): TopologyDraftNode[] {
  const seen = new Set<string>();
  const output: TopologyDraftNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    output.push(node);
  }
  return output;
}

function dedupeEdges(edges: readonly TopologyDraftEdge[]): TopologyDraftEdge[] {
  const seen = new Set<string>();
  const output: TopologyDraftEdge[] = [];
  for (const edge of edges) {
    const id = topologyEdgeId(edge);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(edge);
  }
  return output;
}

function validEdge(edge: TopologyDraftEdge, nodeIds: ReadonlySet<string>): boolean {
  return (
    nodeIds.has(edge.source) &&
    nodeIds.has(edge.target) &&
    edge.source !== edge.target &&
    Number.isInteger(edge.port) &&
    edge.port > 0 &&
    edge.port <= 65_535
  );
}

function finalizeDraft(
  seed: DraftSeed,
  input: TopologyLearningInput,
  index: TopologyIndex,
  options: FinalizeOptions,
): TopologyDraft {
  const nodes = sortNodes(dedupeNodes(seed.nodes)).slice(0, MAX_DRAFT_NODES);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const candidateEdges = dedupeEdges(seed.edges).filter((edge) => validEdge(edge, nodeIds));
  const edges = [...candidateEdges]
    .sort((a, b) => b.count - a.count || compareText(topologyEdgeId(a), topologyEdgeId(b)))
    .slice(0, MAX_DRAFT_EDGES)
    .sort(compareEdgeEndpoints);
  const edgeIds = new Set(edges.map((edge) => topologyEdgeId(edge)));

  const systems = buildSystems(nodes);

  const rawInsights =
    seed.insights.length > 0 ? seed.insights : buildHeuristicInsights(nodes, edges, input);
  const insights = capInsights(rawInsights.map((insight) => filterInsightRefs(insight, nodeIds, edgeIds)));

  const rawHotPaths =
    seed.hotPaths.length > 0 ? seed.hotPaths : buildHotPaths(nodes, edges);
  const hotPaths = capHotPaths(
    rawHotPaths
      .map((hotPath) =>
        defined<TopologyHotPath>({
          label: hotPath.label,
          nodeIds: hotPath.nodeIds.filter((id) => nodeIds.has(id)),
          edgeIds: hotPath.edgeIds.filter((id) => edgeIds.has(id)),
          connections: Math.max(0, nonNegativeInt(hotPath.connections) ?? 0),
        }),
      )
      .filter((hotPath) => hotPath.nodeIds.length >= 2),
  );

  const rawRisks =
    seed.risks.length > 0 ? seed.risks : insights.filter((insight) => insight.severity !== 'info');
  const risks = capInsights(rawRisks.map((risk) => filterInsightRefs(risk, nodeIds, edgeIds)));

  const summary = seed.summary.trim()
    ? seed.summary.trim()
    : buildSummary(input, nodes, edges, systems, risks, index);

  const confidence =
    options.mode === 'heuristic'
      ? computeHeuristicConfidence(nodes, edges, systems)
      : computeModelConfidence(
          options.modelStats,
          index,
          insights,
          hotPaths,
          options.reportedConfidence,
        );

  return {
    nodes,
    edges,
    insights,
    hotPaths,
    risks,
    summary,
    systems,
    confidence,
  };
}

function buildHeuristicDraftFromIndex(input: TopologyLearningInput, index: TopologyIndex): TopologyDraft {
  const allNodes = buildHeuristicNodes(index);
  const cappedNodes = sortNodes(allNodes).slice(0, MAX_DRAFT_NODES);
  const nodeIds = new Set(cappedNodes.map((node) => node.id));
  const edgeCandidates = buildHeuristicEdges(index, nodeIds)
    .sort((a, b) => b.count - a.count || compareText(topologyEdgeId(a), topologyEdgeId(b)))
    .slice(0, MAX_DRAFT_EDGES);
  return finalizeDraft(
    {
      nodes: cappedNodes,
      edges: edgeCandidates,
      insights: [],
      hotPaths: [],
      risks: [],
      summary: '',
    },
    input,
    index,
    { mode: 'heuristic', modelStats: EMPTY_MODEL_STATS, reportedConfidence: 0.6 },
  );
}

/** 纯函数兜底入口（测试/控制面可直接调用）：确定性生成可渲染拓扑 draft。 */
export function buildHeuristicDraft(input: TopologyLearningInput): TopologyDraft {
  return buildHeuristicDraftFromIndex(input, buildTopologyIndex(input));
}

// ---------------------------------------------------------------------------
// 大模型 Prompt
// ---------------------------------------------------------------------------

const TOPOLOGY_SYSTEM_PROMPT = [
  '你是 OpsAgent 的资深 SRE 架构师，负责把真实主机建连数据整理成「一眼看懂」的业务访问拓扑。',
  '',
  '任务：分析固定时间窗口内的主机、监听服务、建连边和外部依赖，输出分层拓扑图和具体洞察。',
  '',
  '硬性输出要求：',
  '1. 只输出一个严格 JSON 对象；不要 Markdown 围栏，不要解释、前后缀或注释。',
  '2. 节点 id 只能使用输入中出现的 id（hosts[].id、externalPeers[].id、edges[].from/to）；禁止编造节点或 id。',
  '3. 输入里 edges[].from / edges[].to 是边两端的节点 id；输出 edges 时用 source / target（与 from/to 相同）。',
  '4. 端口用输入中的真实端口；opened / failed 用输入边的真实数字；count 参考 opened / active 的真实数量。',
  '5. 分层 tier 只能取 ingress / app / middleware / data / external / infra。',
  '6. kind 只能取 gateway / service / database / cache / mq / storage / external / unknown。',
  '7. 业务系统分组必须使用输入中的 appSystemId 原值；节点 label 用主机名或服务名（可用中文）。',
  '8. 未纳管外部 peer 必须建成 external 节点，label 用 IP。',
  '9. insights 必须具体：引用真实节点/边和数字，说明为什么重要；severity 只能是 info / warning / critical；最多 8 条。',
  '10. risks 只放 warning / critical 的风险；hotPaths 最多 5 条、每条最多 5 个节点。',
  '11. hotPaths.edgeIds 和 insights.edgeIds 使用「e:源id->目标id:端口」格式，例如 e:e:h:ab12cd34->h:ef56gh78:3306。',
  '12. confidence 取 0~1，表示整体结论可信度；数据越完整越高。输出节点不超过 120 个、边不超过 240 条。',
  '',
  'JSON schema：',
  '{',
  '  "summary": "string",',
  '  "nodes": [{"id": "string", "label": "string", "kind": "gateway|service|database|cache|mq|storage|external|unknown", "tier": "ingress|app|middleware|data|external|infra", "hostname": "string?", "ip": "string?", "appSystemId": "string|null?", "appSystemName": "string?", "status": "online|offline|unknown?", "services": [{"name": "string", "port": 3306, "process": "string?"}], "inferred": true, "note": "string?"}],',
  '  "edges": [{"source": "string", "target": "string", "port": 3306, "count": 100, "opened": 90, "failed": 2, "protocol": "tcp", "label": "string?", "confidence": 0.9}],',
  '  "insights": [{"id": "string", "title": "string", "detail": "string", "severity": "info|warning|critical", "nodeIds": ["string"], "edgeIds": ["string"]}],',
  '  "hotPaths": [{"label": "string", "nodeIds": ["string"], "edgeIds": ["string"], "connections": 100}],',
  '  "risks": [{"id": "string", "title": "string", "detail": "string", "severity": "warning|critical", "nodeIds": ["string"], "edgeIds": ["string"]}],',
  '  "confidence": 0.85',
  '}',
  '',
  '示例（只示意格式和颗粒度）：',
  '{"summary":"窗口内 4 台主机、3 条访问关系、2 个业务系统；核心链路 web-01 → db-01:3306（128 次）；发现 1 个风险。","nodes":[{"id":"h:ab12cd34","label":"web-01","kind":"gateway","tier":"ingress","hostname":"web-01","ip":"10.0.1.11","appSystemId":"as-1001","appSystemName":"订单系统","status":"online","services":[{"name":"nginx","port":80}]},{"id":"h:ef56gh78","label":"db-01","kind":"database","tier":"data","hostname":"db-01","ip":"10.0.2.21","appSystemId":"as-1001","appSystemName":"订单系统","status":"online","services":[{"name":"mysql","port":3306}]}],"edges":[{"source":"h:ab12cd34","target":"h:ef56gh78","port":3306,"count":128,"opened":96,"failed":2,"protocol":"tcp","confidence":0.9}],"insights":[{"id":"i-1","title":"数据库出现少量失败","detail":"web-01 → db-01:3306 失败 2/96（2.1%），建议观察重试与连接池。","severity":"info","nodeIds":["h:ab12cd34","h:ef56gh78"],"edgeIds":["e:h:ab12cd34->h:ef56gh78:3306"]}],"hotPaths":[{"label":"web-01 → db-01","nodeIds":["h:ab12cd34","h:ef56gh78"],"edgeIds":["e:h:ab12cd34->h:ef56gh78:3306"],"connections":128}],"risks":[],"confidence":0.82}',
  '',
  '注意：即使输入数据很少，也要给出至少一条有信息量的 insight。',
].join('\n');

export interface TopologyPromptService {
  readonly name: string;
  readonly port: number;
  readonly process?: string;
}

export interface TopologyPromptHost {
  readonly id: string;
  readonly hostname: string;
  readonly ip: string;
  readonly status: string;
  readonly appSystemId: string | null;
  readonly appSystemName: string;
  readonly services: readonly TopologyPromptService[];
  readonly anomalies?: readonly string[];
}

export interface TopologyPromptEdge {
  readonly from: string;
  readonly to: string;
  readonly port: number;
  readonly count: number;
  readonly opened: number;
  readonly active: number;
  readonly failed: number;
  readonly protocol: string;
  readonly direction: 'out' | 'in' | 'both';
  readonly service?: string;
  readonly external?: true;
}

export interface TopologyPromptPeer {
  readonly id: string;
  readonly ip: string;
  readonly ports: readonly number[];
  readonly processes: readonly string[];
  readonly opened: number;
  readonly failed: number;
}

export interface TopologyPromptPayload {
  readonly scope: {
    readonly kind: string;
    readonly appSystemId: string | null;
    readonly appSystemName?: string;
  };
  readonly window: { readonly start: string; readonly end: string; readonly seconds: number };
  readonly stats: TopologyGraphStats;
  readonly hosts: readonly TopologyPromptHost[];
  readonly edges: readonly TopologyPromptEdge[];
  readonly externalPeers: readonly TopologyPromptPeer[];
}

export interface TopologyPrompt {
  readonly system: string;
  readonly prompt: string;
  readonly payload: TopologyPromptPayload;
}

function buildPromptPayload(input: TopologyLearningInput, index: TopologyIndex): TopologyPromptPayload {
  const hostVolume = (host: ManagedHost): number =>
    (index.inboundByNode.get(host.id) ?? 0) + (index.outboundByNode.get(host.id) ?? 0);
  const promptHosts: TopologyPromptHost[] = [...index.managedHosts]
    .sort(
      (a, b) =>
        hostVolume(b) - hostVolume(a) ||
        compareText(a.hostname, b.hostname) ||
        compareText(a.id, b.id),
    )
    .slice(0, MAX_PROMPT_HOSTS)
    .map((host) => {
      const services = host.services.slice(0, 8).map((service) =>
        defined<TopologyPromptService>({
          name: service.name,
          port: service.port,
          process: service.process || undefined,
        }),
      );
      return defined<TopologyPromptHost>({
        id: host.id,
        hostname: host.hostname,
        ip: host.ip,
        status: host.status,
        appSystemId: host.appSystemId,
        appSystemName: host.appSystemName,
        services,
        anomalies: host.anomalies.length > 0 ? host.anomalies.slice(0, 3) : undefined,
      });
    });

  const edgeVolume = (edge: ResolvedEdge): number => edge.opened + edge.active + edge.failed;
  const promptEdges: TopologyPromptEdge[] = [...index.edges]
    .sort(
      (a, b) =>
        edgeVolume(b) - edgeVolume(a) ||
        compareText(edgeKey(a.source, a.target, a.port), edgeKey(b.source, b.target, b.port)),
    )
    .slice(0, MAX_PROMPT_EDGES)
    .map((edge) =>
      defined<TopologyPromptEdge>({
        from: edge.source,
        to: edge.target,
        port: edge.port,
        count: Math.max(edge.opened, edge.active, 1),
        opened: edge.opened,
        active: edge.active,
        failed: edge.failed,
        protocol: edge.protocol,
        direction: edge.direction,
        service: edge.toService || undefined,
        external: edge.external ? true : undefined,
      }),
    );

  const promptPeers: TopologyPromptPeer[] = [...index.externalNodes]
    .sort(
      (a, b) =>
        b.opened + b.failed - (a.opened + a.failed) ||
        compareText(a.ip, b.ip) ||
        compareText(a.id, b.id),
    )
    .slice(0, MAX_PROMPT_PEERS)
    .map((external) => ({
      id: external.id,
      ip: external.ip,
      ports: [...external.ports].sort((a, b) => a - b).slice(0, 8),
      processes: [...external.processes].slice(0, 4),
      opened: external.opened,
      failed: external.failed,
    }));

  return {
    scope: defined<TopologyPromptPayload['scope']>({
      kind: input.scope.kind,
      appSystemId: input.scope.appSystemId ?? null,
      appSystemName: input.scope.appSystemName || undefined,
    }),
    window: {
      start: input.window.start,
      end: input.window.end,
      seconds: input.window.seconds,
    },
    stats: input.stats,
    hosts: promptHosts,
    edges: promptEdges,
    externalPeers: promptPeers,
  };
}

function buildTopologyPromptFromIndex(
  input: TopologyLearningInput,
  index: TopologyIndex,
): TopologyPrompt {
  const payload = buildPromptPayload(input, index);
  const prompt = [
    '任务：根据下面的固定时间窗口建连数据，输出严格 JSON 格式的业务访问拓扑分析（summary / nodes / edges / insights / hotPaths / risks / confidence）。',
    '',
    '输入数据（紧凑 JSON；字段：scope / window / stats / hosts / edges / externalPeers。hosts[].id、externalPeers[].id 是节点 id，edges[].from / edges[].to 引用这些 id）：',
    JSON.stringify(payload),
    '',
    '请只输出拓扑分析 JSON，不要 Markdown 围栏或解释。',
  ].join('\n');
  return { system: TOPOLOGY_SYSTEM_PROMPT, prompt, payload };
}

/** 构造发给模型的 prompt（暴露给测试，校验输入压缩与嵌入字段名）。 */
export function buildTopologyPrompt(input: TopologyLearningInput): TopologyPrompt {
  return buildTopologyPromptFromIndex(input, buildTopologyIndex(input));
}

// ---------------------------------------------------------------------------
// 模型输出解析 / 校验 / 真实数字回填
// ---------------------------------------------------------------------------

function extractJsonObject(answer: string): Record<string, unknown> {
  const trimmed = answer.trim();
  if (!trimmed) throw new Error('model_empty_response');
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const record = asRecord(parsed);
      if (record) return record;
    } catch {
      // 尝试下一个候选片段。
    }
  }
  throw new Error('model_json_invalid');
}

function parseModelServices(value: unknown): TopologyServicePort[] {
  if (!Array.isArray(value)) return [];
  const byPort = new Map<number, TopologyServicePort>();
  for (const item of value.slice(0, 40)) {
    const record = asRecord(item);
    if (!record) continue;
    const port = positiveInt(record.port);
    if (port === null || byPort.has(port)) continue;
    const name = text(record.name, 80);
    if (!name) continue;
    byPort.set(
      port,
      defined<TopologyServicePort>({
        name,
        port,
        process: text(record.process, 80) || undefined,
        pid: nonNegativeInt(record.pid) ?? undefined,
      }),
    );
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port).slice(0, 24);
}

function parseInsight(
  value: unknown,
  ordinal: number,
  nodeById: ReadonlyMap<string, unknown>,
  edgeIds: ReadonlySet<string>,
  idPrefix: string,
): TopologyInsight | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = text(record.title, 120);
  const detail = text(record.detail, 600);
  if (!title && !detail) return null;
  const keptNodeIds = stringArray(record.nodeIds)
    .filter((id) => nodeById.has(id))
    .slice(0, 8);
  const keptEdgeIds = stringArray(record.edgeIds)
    .filter((id) => edgeIds.has(id))
    .slice(0, 8);
  return defined<TopologyInsight>({
    id: text(record.id, 64) || `${idPrefix}-${ordinal}`,
    title: title || cut(detail, 120),
    detail: detail || title,
    severity: isSeverity(record.severity) ? record.severity : 'info',
    nodeIds: keptNodeIds.length > 0 ? keptNodeIds : undefined,
    edgeIds: keptEdgeIds.length > 0 ? keptEdgeIds : undefined,
  });
}

function parseInsightList(
  value: unknown,
  nodeById: ReadonlyMap<string, unknown>,
  edgeIds: ReadonlySet<string>,
  idPrefix: string,
  max: number,
): TopologyInsight[] {
  if (!Array.isArray(value)) return [];
  const output: TopologyInsight[] = [];
  for (const item of value.slice(0, 100)) {
    const insight = parseInsight(item, output.length + 1, nodeById, edgeIds, idPrefix);
    if (insight) output.push(insight);
    if (output.length >= max) break;
  }
  return output;
}

function edgesForPath(
  pathNodeIds: readonly string[],
  edgeByKey: ReadonlyMap<string, TopologyDraftEdge>,
): string[] {
  const edgeIds: string[] = [];
  for (let index = 0; index < pathNodeIds.length - 1; index += 1) {
    const source = pathNodeIds[index];
    const target = pathNodeIds[index + 1];
    if (!source || !target) continue;
    let best: TopologyDraftEdge | null = null;
    for (const edge of edgeByKey.values()) {
      if (edge.source !== source || edge.target !== target) continue;
      if (!best || edge.count > best.count) best = edge;
    }
    if (best) edgeIds.push(topologyEdgeId(best));
  }
  return edgeIds;
}

function parseHotPath(
  value: unknown,
  ordinal: number,
  nodeById: ReadonlyMap<string, TopologyDraftNode>,
  edgeByKey: ReadonlyMap<string, TopologyDraftEdge>,
): TopologyHotPath | null {
  const record = asRecord(value);
  if (!record) return null;
  const seen = new Set<string>();
  const pathNodeIds: string[] = [];
  for (const id of stringArray(record.nodeIds)) {
    if (!nodeById.has(id) || seen.has(id)) continue;
    seen.add(id);
    pathNodeIds.push(id);
    if (pathNodeIds.length >= MAX_HOT_PATH_NODES) break;
  }
  if (pathNodeIds.length < 2) return null;
  const providedEdgeIds = stringArray(record.edgeIds).filter((id) => edgeByKey.has(id));
  const expectedEdgeCount = pathNodeIds.length - 1;
  const derivedEdgeIds = edgesForPath(pathNodeIds, edgeByKey);
  const edgeIds =
    providedEdgeIds.length >= expectedEdgeCount && providedEdgeIds.length > 0
      ? providedEdgeIds.slice(0, expectedEdgeCount)
      : derivedEdgeIds;
  if (edgeIds.length === 0) return null;
  const derivedConnections = edgeIds.reduce(
    (sum, id) => sum + (edgeByKey.get(id)?.count ?? 0),
    0,
  );
  const providedConnections = nonNegativeInt(record.connections);
  const fallbackLabel = pathNodeIds
    .map((id) => nodeById.get(id)?.label ?? id)
    .join(' → ');
  return {
    label: text(record.label, 80) || cut(fallbackLabel, 80),
    nodeIds: pathNodeIds,
    edgeIds,
    connections: providedConnections ?? derivedConnections,
  };
}

function parseModelDraft(
  answer: string,
  input: TopologyLearningInput,
  index: TopologyIndex,
): {
  readonly draft: DraftSeed;
  readonly stats: ModelParseStats;
  readonly reportedConfidence: number;
} {
  const root = extractJsonObject(answer);
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  const rawEdges = Array.isArray(root.edges) ? root.edges : [];

  const canonicalId = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return index.idByLower.get(trimmed.toLowerCase()) ?? null;
  };

  const nodesById = new Map<string, TopologyDraftNode>();
  let droppedNodes = 0;
  for (const raw of rawNodes.slice(0, 500)) {
    const record = asRecord(raw);
    if (!record) {
      droppedNodes += 1;
      continue;
    }
    const id = canonicalId(record.id);
    if (!id || nodesById.has(id)) {
      droppedNodes += 1;
      continue;
    }
    const host = index.managedById.get(id);
    const external = index.externalById.get(id);
    if (!host && !external) {
      droppedNodes += 1;
      continue;
    }
    const services = parseModelServices(record.services);
    const fallbackServices = host
      ? host.services
      : external
        ? [...external.services.values()].sort((a, b) => a.port - b.port)
        : [];
    const nodeServices = (services.length > 0 ? services : fallbackServices).slice(0, 24);
    const fallbackClassification: HostClassification = host
      ? classifyManagedHost(host, {
          inbound: index.inboundByNode.get(id) ?? 0,
          total: (index.inboundByNode.get(id) ?? 0) + (index.outboundByNode.get(id) ?? 0),
        })
      : { tier: 'external', kind: 'external' };
    const tier: TopologyTier = isTier(record.tier) ? record.tier : fallbackClassification.tier;
    const kind: TopologyNodeKind = isKind(record.kind) ? record.kind : fallbackClassification.kind;
    const status: TopologyNodeStatus = isStatus(record.status)
      ? record.status
      : host
        ? mapHostStatus(host.status)
        : 'unknown';
    const label = text(record.label, 80) || host?.hostname || external?.ip || id;
    const hostname = host?.hostname || text(record.hostname, 120) || external?.ip || '';
    const ip = host?.ip || text(record.ip, 120) || external?.ip || '';
    // 业务系统分组永远取输入原值，避免模型改写导致分组漂移。
    const appSystemId = host ? host.appSystemId : null;
    const appSystemName = host ? host.appSystemName : '';
    const inferred =
      typeof record.inferred === 'boolean'
        ? record.inferred
        : external
          ? true
          : host
            ? false
            : true;
    const note =
      text(record.note, 300) ||
      (external
        ? '未纳管外部依赖'
        : host?.synthetic
          ? '未在主机清单中，由建连边推断'
          : '');
    nodesById.set(
      id,
      defined<TopologyDraftNode>({
        id,
        label,
        kind,
        tier,
        hostname: hostname || undefined,
        ip: ip || undefined,
        appSystemId,
        appSystemName: appSystemName || undefined,
        status,
        services: nodeServices,
        inferred,
        note: note || undefined,
      }),
    );
  }
  if (nodesById.size === 0) throw new Error('model_nodes_empty');

  const nodeIdSet = new Set(nodesById.keys());
  const mergedEdges = new Map<string, TopologyDraftEdge>();
  let droppedEdges = 0;
  let matchedEdges = 0;
  for (const raw of rawEdges.slice(0, 800)) {
    const record = asRecord(raw);
    if (!record) {
      droppedEdges += 1;
      continue;
    }
    // 兼容模型用 source/target 或输入里的 from/to 字段名。
    const source = canonicalId(record.source ?? record.from);
    const target = canonicalId(record.target ?? record.to);
    if (!source || !target || !nodeIdSet.has(source) || !nodeIdSet.has(target) || source === target) {
      droppedEdges += 1;
      continue;
    }
    const port = positiveInt(record.port);
    if (port === null) {
      droppedEdges += 1;
      continue;
    }
    const modelOpened = nonNegativeInt(record.opened) ?? 0;
    const modelFailed = nonNegativeInt(record.failed) ?? 0;
    const modelCount = nonNegativeInt(record.count);
    const inputEdge = index.inputEdgeByKey.get(edgeKey(source, target, port));
    let opened = modelOpened;
    let failed = modelFailed;
    let count = modelCount ?? Math.max(modelOpened, 1);
    let confidence = clampNumber(numberValue(record.confidence, 0.7), 0, 1);
    if (inputEdge) {
      opened = inputEdge.opened;
      failed = inputEdge.failed;
      count = Math.max(inputEdge.opened, inputEdge.active, 1);
      confidence = Math.min(confidence, 0.9);
      matchedEdges += 1;
    } else {
      confidence = Math.min(confidence, 0.5);
    }
    const protocol = text(record.protocol, 20) || inputEdge?.protocol || 'tcp';
    const id = edgeKey(source, target, port);
    const edge: TopologyDraftEdge = defined<TopologyDraftEdge>({
      source,
      target,
      port,
      count,
      opened,
      failed,
      protocol,
      label: text(record.label, 80) || undefined,
      confidence: round2(confidence),
    });
    const existing = mergedEdges.get(id);
    if (!existing) {
      mergedEdges.set(id, edge);
    } else {
      mergedEdges.set(
        id,
        defined<TopologyDraftEdge>({
          ...existing,
          count: Math.max(existing.count, edge.count),
          opened: Math.max(existing.opened ?? 0, edge.opened ?? 0),
          failed: Math.max(existing.failed ?? 0, edge.failed ?? 0),
          confidence: Math.max(existing.confidence ?? 0, edge.confidence ?? 0),
        }),
      );
    }
  }

  const edges = [...mergedEdges.values()];
  const matchedHosts = [...nodesById.keys()].filter((id) => index.managedById.has(id)).length;
  const edgeByKey = new Map(edges.map((edge) => [topologyEdgeId(edge), edge]));
  const edgeIdSet = new Set(edgeByKey.keys());
  const nodeMapForRefs: ReadonlyMap<string, TopologyDraftNode> = nodesById;

  const insights = parseInsightList(root.insights, nodeMapForRefs, edgeIdSet, 'model-insight', MAX_INSIGHTS);
  const risks = parseInsightList(root.risks, nodeMapForRefs, edgeIdSet, 'model-risk', MAX_INSIGHTS);
  const hotPaths: TopologyHotPath[] = [];
  if (Array.isArray(root.hotPaths)) {
    for (const item of root.hotPaths.slice(0, 20)) {
      const hotPath = parseHotPath(item, hotPaths.length + 1, nodeMapForRefs, edgeByKey);
      if (hotPath) hotPaths.push(hotPath);
      if (hotPaths.length >= MAX_HOT_PATHS) break;
    }
  }

  return {
    draft: {
      nodes: [...nodesById.values()],
      edges,
      insights,
      hotPaths,
      risks,
      summary: text(root.summary, 1200),
    },
    stats: { matchedHosts, matchedEdges, droppedNodes, droppedEdges },
    reportedConfidence: clampNumber(numberValue(root.confidence, 0.8), 0, 1),
  };
}

// ---------------------------------------------------------------------------
// 对外服务
// ---------------------------------------------------------------------------

function buildAnalysis(
  draft: TopologyDraft,
  details: {
    readonly model: string;
    readonly generatedAt: string;
    readonly durationMs: number;
    readonly fallback: boolean;
    readonly warning?: string;
  },
): TopologyAnalysis {
  return {
    summary: draft.summary ?? '',
    insights: draft.insights ?? [],
    hotPaths: draft.hotPaths ?? [],
    risks: draft.risks ?? [],
    model: details.model,
    promptVersion: TOPOLOGY_PROMPT_VERSION,
    generatedAt: details.generatedAt,
    confidence: draft.confidence ?? 0.6,
    durationMs: details.durationMs,
    fallback: details.fallback,
    ...(details.warning ? { warning: details.warning } : {}),
  };
}

export class TopologyAnalyzer {
  constructor(private readonly completion: ModelCompletionService) {}

  async analyze(
    tenantId: string,
    input: TopologyLearningInput,
    options?: AnalyzeTopologyOptions,
  ): Promise<TopologyAnalysisResult> {
    const startedAt = Date.now();
    const generatedAt = new Date().toISOString();
    const index = buildTopologyIndex(input);
    const requestedLabel = options?.modelLabel?.trim() ?? '';
    const modelLabel = requestedLabel || DEFAULT_MODEL_LABEL;

    try {
      const { system, prompt } = buildTopologyPromptFromIndex(input, index);
      const answer = await this.requestCompletion(tenantId, system, prompt, options);
      const parsed = parseModelDraft(answer, input, index);
      const draft = finalizeDraft(parsed.draft, input, index, {
        mode: 'model',
        modelStats: parsed.stats,
        reportedConfidence: parsed.reportedConfidence,
      });
      return {
        draft,
        analysis: buildAnalysis(draft, {
          model: modelLabel,
          generatedAt,
          durationMs: Date.now() - startedAt,
          fallback: false,
        }),
      };
    } catch {
      let draft: TopologyDraft;
      try {
        draft = buildHeuristicDraftFromIndex(input, index);
      } catch {
        // 极端兜底：启发式也失败时返回空图（可渲染的空态），不抛错。
        draft = {
          nodes: [],
          edges: [],
          insights: [
            {
              id: 'insight-empty',
              title: '窗口内暂无有效访问关系',
              detail: '未采集到可分析的建连数据，请确认 Agent 连接采集是否开启，或扩大学习时间窗口后重试。',
              severity: 'info',
            },
          ],
          hotPaths: [],
          risks: [],
          summary: '窗口内未采集到可分析的建连数据；核心链路 无显著访问关系；发现 0 个风险。',
          systems: [],
          confidence: 0.55,
        };
      }
      return {
        draft,
        analysis: buildAnalysis(draft, {
          model: 'heuristic',
          generatedAt,
          durationMs: Date.now() - startedAt,
          fallback: true,
          warning: TOPOLOGY_FALLBACK_WARNING,
        }),
      };
    }
  }

  private async requestCompletion(
    tenantId: string,
    system: string,
    prompt: string,
    options?: AnalyzeTopologyOptions,
  ): Promise<string> {
    const maxTokens = clampInt(options?.maxTokens ?? 2600, 128, 4096);
    const timeoutMs = clampInt(options?.timeoutMs ?? 45_000, 1_000, 45_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('model_timeout')), timeoutMs);
      timer.unref?.();
    });
    try {
      const answer = await Promise.race([
        this.completion.complete({ tenantId, system, prompt, maxTokens }),
        timeout,
      ]);
      const trimmed = typeof answer === 'string' ? answer.trim() : '';
      if (!trimmed) throw new Error('model_empty_response');
      return trimmed;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
