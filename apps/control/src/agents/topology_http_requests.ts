import type { Pool } from 'pg';
import type {
  HttpRequestTrendBucket,
  HttpRequestTrendRow,
  HttpRequestTrendsResponse,
  TopologyEdgeTag,
} from '@opsagent/contracts';
import { TopologyEdgeTagService, topologyRelationKey } from './topology_tags.js';

/**
 * HTTP/gRPC 请求级计数：Agent 七层旁路解析（仅明文）随心跳上报窗口样本，
 * 控制面负责幂等入库、7 天保留与访问量趋势聚合。
 */

/** 心跳一次最多携带的 HTTP 请求窗口数。 */
export const MAX_HTTP_REQUEST_WINDOWS = 10;
/** 单窗口最多接收的请求边数。 */
export const MAX_HTTP_REQUEST_EDGES = 200;
const MAX_HTTP_UPSERT_BATCH = 200;
const MAX_HTTP_COUNT = 1_000_000_000;
const MAX_HTTP_WINDOW_SECONDS = 3600;
const HTTP_PROTOCOLS = ['http1', 'http2', 'grpc'] as const;
const HTTP_TREND_ROWS = 500;
const HTTP_RAW_ROWS = 20_000;

export type HttpProtocol = 'http1' | 'http2' | 'grpc';
export type HttpTrendBucketUnit = 'hour' | 'day';

export interface NormalizedHttpRequestEdge {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly direction: 'out' | 'in';
  readonly protocol: HttpProtocol;
  readonly method: string;
  readonly localAddress: string;
  readonly localPort: number;
  readonly peerAddress: string;
  readonly peerPort: number;
  readonly service: string;
  readonly requests: number;
  readonly errors: number;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function integer(value: unknown, max = MAX_HTTP_COUNT): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.floor(parsed), max);
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeProtocol(value: unknown): HttpProtocol | null {
  const protocol = text(value, 20).toLowerCase();
  return (HTTP_PROTOCOLS as readonly string[]).includes(protocol) ? protocol as HttpProtocol : null;
}

function uniqueKey(edge: NormalizedHttpRequestEdge): string {
  return [
    edge.windowStart.toISOString(),
    edge.windowEnd.toISOString(),
    edge.direction,
    edge.protocol,
    edge.method,
    edge.localAddress,
    edge.localPort,
    edge.peerAddress,
    edge.peerPort,
  ].join('|');
}

function mergeDuplicate(
  left: NormalizedHttpRequestEdge,
  right: NormalizedHttpRequestEdge,
): NormalizedHttpRequestEdge {
  return {
    ...left,
    requests: Math.min(left.requests + right.requests, MAX_HTTP_COUNT),
    errors: Math.min(left.errors + right.errors, MAX_HTTP_COUNT),
    firstSeen: new Date(Math.min(left.firstSeen.getTime(), right.firstSeen.getTime())),
    lastSeen: new Date(Math.max(left.lastSeen.getTime(), right.lastSeen.getTime())),
  };
}

/** 校验/截断/去重心跳里的 httpRequestWindows；非法项忽略。 */
export function normalizeHttpRequestWindows(value: unknown): NormalizedHttpRequestEdge[] {
  const windows = Array.isArray(value) ? value.slice(0, MAX_HTTP_REQUEST_WINDOWS) : [];
  const normalized: NormalizedHttpRequestEdge[] = [];
  for (const rawWindow of windows) {
    const window = asObject(rawWindow);
    if (!window) continue;
    const windowStart = timestamp(window.start);
    const windowEnd = timestamp(window.end);
    if (!windowStart || !windowEnd || windowEnd.getTime() <= windowStart.getTime()) continue;
    if (windowEnd.getTime() - windowStart.getTime() > MAX_HTTP_WINDOW_SECONDS * 1000) continue;
    const rawEdges = Array.isArray(window.requests) ? window.requests.slice(0, MAX_HTTP_REQUEST_EDGES) : [];
    for (const rawEdge of rawEdges) {
      const edge = asObject(rawEdge);
      if (!edge) continue;
      const direction = edge.direction === 'in' ? 'in' : edge.direction === 'out' ? 'out' : null;
      if (!direction) continue;
      const protocol = normalizeProtocol(edge.protocol);
      if (!protocol) continue;
      const peerAddress = text(edge.peerAddress, 160);
      const localAddress = text(edge.localAddress, 160);
      const peerPort = integer(edge.peerPort, 65535);
      const localPort = integer(edge.localPort, 65535);
      if (!peerAddress || peerPort === 0) continue;
      const firstSeen = timestamp(edge.firstSeen) ?? windowStart;
      const lastSeen = timestamp(edge.lastSeen) ?? windowEnd;
      normalized.push({
        windowStart,
        windowEnd,
        direction,
        protocol,
        method: text(edge.method, 20).toUpperCase() || 'UNKNOWN',
        localAddress,
        localPort,
        peerAddress,
        peerPort,
        service: text(edge.service, 120),
        requests: integer(edge.requests),
        errors: integer(edge.errors),
        firstSeen,
        lastSeen,
      });
    }
  }
  const unique = new Map<string, NormalizedHttpRequestEdge>();
  for (const edge of normalized) {
    const key = uniqueKey(edge);
    const current = unique.get(key);
    unique.set(key, current ? mergeDuplicate(current, edge) : edge);
  }
  return [...unique.values()];
}

/** HTTP/gRPC 请求窗口样本入库服务（心跳侧调用，失败不影响心跳）。 */
export class AgentHttpRequestService {
  private lastPurgeAt = 0;

  constructor(private readonly pool: Pool) {}

  async sync(tenantId: string, agentId: string, windows: unknown): Promise<number> {
    const edges = normalizeHttpRequestWindows(windows);
    if (edges.length === 0) return 0;
    for (let offset = 0; offset < edges.length; offset += MAX_HTTP_UPSERT_BATCH) {
      await this.upsertBatch(tenantId, agentId, edges.slice(offset, offset + MAX_HTTP_UPSERT_BATCH));
    }
    // 低频清理 7 天前数据（不阻塞心跳）。
    if (Date.now() - this.lastPurgeAt > 60 * 60 * 1000) {
      this.lastPurgeAt = Date.now();
      void this.purgeOlderThan(7).catch((error) => {
        console.warn('[topology] purge old http requests failed', error);
      });
    }
    return edges.length;
  }

  private async upsertBatch(
    tenantId: string,
    agentId: string,
    edges: readonly NormalizedHttpRequestEdge[],
  ): Promise<void> {
    const columnsPerRow = 16;
    const placeholders: string[] = [];
    const values: unknown[] = [];
    for (const [index, edge] of edges.entries()) {
      const base = index * columnsPerRow;
      placeholders.push(`(${Array.from({ length: columnsPerRow }, (_, column) => `$${base + column + 1}`).join(', ')})`);
      values.push(
        tenantId,
        agentId,
        edge.windowStart,
        edge.windowEnd,
        edge.direction,
        edge.protocol,
        edge.method,
        edge.localAddress,
        edge.localPort,
        edge.peerAddress,
        edge.peerPort,
        edge.service,
        edge.requests,
        edge.errors,
        edge.firstSeen,
        edge.lastSeen,
      );
    }
    await this.pool.query(
      `INSERT INTO agent_http_requests
         (tenant_id, agent_id, window_start, window_end, direction, protocol, method,
          local_address, local_port, peer_address, peer_port, service,
          requests, errors, first_seen, last_seen)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (tenant_id, agent_id, window_start, window_end, direction, protocol,
                    method, local_address, local_port, peer_address, peer_port)
       DO UPDATE SET requests = EXCLUDED.requests,
         errors = EXCLUDED.errors,
         service = EXCLUDED.service,
         first_seen = LEAST(agent_http_requests.first_seen, EXCLUDED.first_seen),
         last_seen = GREATEST(agent_http_requests.last_seen, EXCLUDED.last_seen),
         received_at = now()`,
      values,
    );
  }

  async purgeOlderThan(days = 7): Promise<number> {
    const keepDays = Math.min(Math.max(Math.floor(days), 1), 3650);
    const result = await this.pool.query(
      'DELETE FROM agent_http_requests WHERE received_at < now() - make_interval(days => $1)',
      [keepDays],
    );
    return result.rowCount ?? 0;
  }
}

export class HttpRequestTrendError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'HttpRequestTrendError';
  }
}

export interface HttpRequestAgentSource {
  readonly id: string;
  readonly hostname: string;
  readonly systemInfo: Readonly<Record<string, unknown>>;
}

export interface HttpRequestAggregateSource {
  readonly agentId: string;
  readonly direction: 'out' | 'in';
  readonly protocol: HttpProtocol;
  readonly method: string;
  readonly service: string;
  readonly peerAddress: string;
  readonly peerPort: number;
  readonly bucketStart: Date;
  readonly requests: number;
  readonly errors: number;
  readonly lastSeen: Date | null;
}

export interface BuildHttpRequestTrendsArgs {
  readonly rows: readonly HttpRequestAggregateSource[];
  readonly bucket: HttpTrendBucketUnit;
  readonly from: Date;
  readonly to: Date;
  readonly agents: readonly HttpRequestAgentSource[];
  readonly tags?: readonly TopologyEdgeTag[];
  readonly limit?: number;
}

function normalizeAddress(value: string): string {
  const trimmed = value.split('%')[0]?.trim().toLowerCase() ?? '';
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return unbracketed.startsWith('::ffff:') ? unbracketed.slice(7) : unbracketed;
}

function numberFromDb(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function primaryIp(systemInfo: Readonly<Record<string, unknown>>): string {
  if (typeof systemInfo.ip === 'string' && normalizeAddress(systemInfo.ip)) return normalizeAddress(systemInfo.ip);
  if (Array.isArray(systemInfo.ipAddresses)) {
    for (const address of systemInfo.ipAddresses) {
      if (typeof address === 'string' && normalizeAddress(address)) return normalizeAddress(address);
    }
  }
  return '';
}

/** 窗口内每个桶的起点（UTC 对齐）；最多 200 桶。 */
export function buildHttpRequestBuckets(from: Date, to: Date, bucket: HttpTrendBucketUnit): Date[] {
  const stepMs = bucket === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const start = new Date(from.getTime());
  start.setUTCMinutes(0, 0, 0);
  if (bucket === 'day') start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to.getTime());
  end.setUTCMinutes(0, 0, 0);
  if (bucket === 'day') end.setUTCHours(0, 0, 0, 0);
  const buckets: Date[] = [];
  for (let cursor = start.getTime(); cursor <= end.getTime() && buckets.length < 200; cursor += stepMs) {
    buckets.push(new Date(cursor));
  }
  return buckets;
}

interface HttpTrendGroup {
  readonly agentId: string;
  readonly direction: 'out' | 'in';
  readonly protocol: HttpProtocol;
  readonly method: string;
  readonly service: string;
  readonly peerAddress: string;
  readonly peerPort: number;
  readonly bucketTotals: Map<string, { requests: number; errors: number }>;
  totalRequests: number;
  totalErrors: number;
  lastSeen: Date | null;
}

/** 纯函数：SQL 桶聚合行 → HTTP 请求趋势行（补零桶、解析主机、挂标签）。 */
export function buildHttpRequestTrends(args: BuildHttpRequestTrendsArgs): HttpRequestTrendRow[] {
  const bucketStarts = buildHttpRequestBuckets(args.from, args.to, args.bucket);
  const bucketKeys = bucketStarts.map((start) => start.toISOString());
  const agentsById = new Map(args.agents.map((agent) => [agent.id, agent]));
  const agentByIp = new Map<string, HttpRequestAgentSource>();
  for (const agent of args.agents) {
    const declared = typeof agent.systemInfo.ip === 'string' ? normalizeAddress(agent.systemInfo.ip) : '';
    if (declared) agentByIp.set(declared, agent);
    if (Array.isArray(agent.systemInfo.ipAddresses)) {
      for (const address of agent.systemInfo.ipAddresses) {
        if (typeof address === 'string' && normalizeAddress(address)) agentByIp.set(normalizeAddress(address), agent);
      }
    }
  }
  const tagsByKey = new Map<string, TopologyEdgeTag[]>();
  for (const tag of args.tags ?? []) {
    const list = tagsByKey.get(tag.relationKey);
    if (list) list.push(tag);
    else tagsByKey.set(tag.relationKey, [tag]);
  }

  const groups = new Map<string, HttpTrendGroup>();
  for (const row of args.rows) {
    const agentId = text(row.agentId, 80);
    const peerAddress = normalizeAddress(text(row.peerAddress, 160));
    if (!agentId || !peerAddress) continue;
    const protocol = normalizeProtocol(row.protocol);
    if (!protocol) continue;
    const method = text(row.method, 20).toUpperCase() || 'UNKNOWN';
    const service = text(row.service, 120);
    const peerPort = Math.max(0, Math.floor(numberFromDb(row.peerPort)));
    const direction = row.direction === 'in' ? 'in' : 'out';
    const key = `${agentId}|${direction}|${protocol}|${method}|${service}|${peerAddress}|${peerPort}`;
    const group = groups.get(key) ?? {
      agentId,
      direction,
      protocol,
      method,
      service,
      peerAddress,
      peerPort,
      bucketTotals: new Map<string, { requests: number; errors: number }>(),
      totalRequests: 0,
      totalErrors: 0,
      lastSeen: null,
    };
    const bucketKey = row.bucketStart.toISOString();
    const requests = Math.max(0, Math.floor(numberFromDb(row.requests)));
    const errors = Math.max(0, Math.floor(numberFromDb(row.errors)));
    const bucket = group.bucketTotals.get(bucketKey) ?? { requests: 0, errors: 0 };
    bucket.requests += requests;
    bucket.errors += errors;
    group.bucketTotals.set(bucketKey, bucket);
    group.totalRequests += requests;
    group.totalErrors += errors;
    if (row.lastSeen instanceof Date && !Number.isNaN(row.lastSeen.getTime())) {
      if (!group.lastSeen || row.lastSeen.getTime() > group.lastSeen.getTime()) group.lastSeen = row.lastSeen;
    }
    groups.set(key, group);
  }

  const rows: HttpRequestTrendRow[] = [];
  for (const group of groups.values()) {
    const sourceAgent = agentsById.get(group.agentId);
    const sourceHost = sourceAgent?.hostname ?? group.agentId;
    const sourceIp = sourceAgent ? primaryIp(sourceAgent.systemInfo) : '';
    const targetAgent = agentByIp.get(group.peerAddress);
    const targetHost = targetAgent?.hostname ?? group.peerAddress;
    const relationKey = topologyRelationKey(sourceHost, targetHost, group.peerPort);
    const buckets: HttpRequestTrendBucket[] = bucketKeys.map((bucketKey) => {
      const bucket = group.bucketTotals.get(bucketKey);
      return { start: bucketKey, requests: bucket?.requests ?? 0, errors: bucket?.errors ?? 0 };
    });
    const tags = tagsByKey.get(relationKey);
    rows.push({
      id: `http:${relationKey}:${group.direction}:${group.protocol}:${group.method}:${group.service}`.slice(0, 400),
      relationKey,
      sourceAgentId: group.agentId,
      sourceHost,
      sourceService: group.service || 'unknown',
      sourceIp,
      targetAgentId: targetAgent?.id ?? null,
      targetHost,
      targetIp: group.peerAddress,
      targetPort: group.peerPort,
      protocol: group.protocol,
      method: group.method,
      totalRequests: group.totalRequests,
      totalErrors: group.totalErrors,
      buckets,
      ...(group.lastSeen ? { lastSeen: group.lastSeen.toISOString() } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    });
  }
  rows.sort((left, right) => right.totalRequests - left.totalRequests
    || left.relationKey.localeCompare(right.relationKey)
    || left.method.localeCompare(right.method));
  return rows.slice(0, Math.max(1, Math.min(args.limit ?? HTTP_TREND_ROWS, HTTP_TREND_ROWS)));
}

export interface HttpRequestTrendOptions {
  readonly windowHours?: number;
  readonly bucket?: HttpTrendBucketUnit;
  readonly appSystemId?: string | null;
}

/** HTTP/gRPC 请求趋势查询服务。 */
export class HttpRequestTrendService {
  private readonly tags: TopologyEdgeTagService;

  constructor(private readonly pool: Pool, tags?: TopologyEdgeTagService) {
    this.tags = tags ?? new TopologyEdgeTagService(pool);
  }

  async get(tenantId: string, options: HttpRequestTrendOptions = {}): Promise<HttpRequestTrendsResponse> {
    const windowHours = options.windowHours === undefined ? 24 : options.windowHours;
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
      throw new HttpRequestTrendError('invalid_window');
    }
    const bucket = options.bucket ?? 'hour';
    if (bucket !== 'hour' && bucket !== 'day') throw new HttpRequestTrendError('invalid_bucket');
    const appSystemId = options.appSystemId ?? null;
    const to = new Date();
    const from = new Date(to.getTime() - windowHours * 60 * 60 * 1000);

    const raw = await this.pool.query<{
      agent_id: string;
      direction: string;
      protocol: string;
      method: string;
      service: string;
      peer_address: string;
      peer_port: number;
      bucket_start: Date;
      requests: string | number;
      errors: string | number;
      last_seen: Date | null;
    }>(
      `SELECT e.agent_id,
              e.direction,
              e.protocol,
              e.method,
              e.service,
              e.peer_address,
              e.peer_port,
              date_trunc($3::text, e.window_start) AS bucket_start,
              sum(e.requests)::bigint AS requests,
              sum(e.errors)::bigint AS errors,
              max(e.last_seen) AS last_seen
       FROM agent_http_requests e
       JOIN agents a ON a.id = e.agent_id AND a.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1
         AND e.window_start >= $4::timestamptz
         AND e.window_start <= $5::timestamptz
         AND ($2::uuid IS NULL OR a.app_system_id = $2)
       GROUP BY e.agent_id, e.direction, e.protocol, e.method, e.service,
                e.peer_address, e.peer_port, bucket_start
       ORDER BY sum(e.requests) DESC
       LIMIT ${HTTP_RAW_ROWS}`,
      [tenantId, appSystemId, bucket, from, to],
    );
    const agents = await this.pool.query<{
      id: string;
      hostname: string;
      system_info: Record<string, unknown>;
    }>(
      'SELECT id, hostname, system_info FROM agents WHERE tenant_id = $1',
      [tenantId],
    );
    const tags = await this.tags.list(tenantId);
    const rows = buildHttpRequestTrends({
      rows: raw.rows.map((row) => ({
        agentId: row.agent_id,
        direction: row.direction === 'in' ? 'in' : 'out',
        protocol: normalizeProtocol(row.protocol) ?? 'http1',
        method: row.method,
        service: row.service,
        peerAddress: row.peer_address,
        peerPort: row.peer_port,
        bucketStart: row.bucket_start,
        requests: numberFromDb(row.requests),
        errors: numberFromDb(row.errors),
        lastSeen: row.last_seen,
      })),
      bucket,
      from,
      to,
      agents: agents.rows.map((row) => ({
        id: row.id,
        hostname: row.hostname,
        systemInfo: row.system_info,
      })),
      tags,
    });
    return {
      windowSeconds: windowHours * 60 * 60,
      bucket,
      from: from.toISOString(),
      to: to.toISOString(),
      rows,
    };
  }
}
