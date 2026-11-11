import type { Pool } from 'pg';
import type {
  AccessTrendBucket,
  AccessTrendRow,
  AccessTrendsResponse,
  TopologyEdgeTag,
} from '@opsagent/contracts';
import {
  TopologyEdgeTagService,
  topologyRelationKey,
} from './topology_tags.js';

/** 访问量趋势：按小时/天分桶聚合 out 方向建连样本，用于量化分析与一键采纳建议标签。 */

export type AccessTrendBucketUnit = 'hour' | 'day';

const MAX_TREND_ROWS = 500;
const MAX_RAW_ROWS = 20_000;
const OPS_PORTS = new Set([22, 3000, 9090, 9100, 10050, 10051]);
const OPS_PROCESS_PATTERN = /(opsagent|sshd|zabbix|node_exporter|prometheus|grafana)/i;
const DATA_PATTERN = /(mysql|mariadb|postgres|postgresql|oracle|mongo|clickhouse|elasticsearch)/i;
const DATA_ES_PATTERN = /(^|[-_])es($|[-_])/i;
const MIDDLEWARE_PATTERN = /(redis|kafka|rabbitmq|nacos|zookeeper)/i;

export class AccessTrendError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AccessTrendError';
  }
}

export interface TrendBucket {
  readonly start: Date;
  readonly opened: number;
  readonly failed: number;
}

export interface TrendAgentSource {
  readonly id: string;
  readonly hostname: string;
  readonly systemInfo: Readonly<Record<string, unknown>>;
}

export interface TrendPortSource {
  readonly agentId: string;
  readonly port: number;
  readonly service: string;
}

/** SQL 聚合后的单桶原始行（同一逻辑关系每个桶一行）。 */
export interface TrendAggregateSource {
  readonly agentId: string;
  readonly sourceService: string;
  readonly processes: string;
  readonly peerAddress: string;
  readonly peerPort: number;
  readonly bucketStart: Date;
  readonly opened: number;
  readonly failed: number;
  readonly lastSeen: Date | null;
}

export interface BuildAccessTrendsArgs {
  readonly rows: readonly TrendAggregateSource[];
  readonly bucket: AccessTrendBucketUnit;
  readonly from: Date;
  readonly to: Date;
  readonly agents: readonly TrendAgentSource[];
  readonly portServices: readonly TrendPortSource[];
  readonly tags?: readonly TopologyEdgeTag[];
  readonly limit?: number;
}

export interface TrendSuggestionInput {
  readonly targetPort: number;
  readonly sourceService: string;
  readonly processes: string;
  readonly targetAgentId: string | null;
  readonly targetService: string;
}

function normalizeAddress(value: string): string {
  const trimmed = value.split('%')[0]?.trim().toLowerCase() ?? '';
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return unbracketed.startsWith('::ffff:') ? unbracketed.slice(7) : unbracketed;
}

function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function numberFromDb(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function primaryIp(systemInfo: Readonly<Record<string, unknown>>): string {
  const declared = typeof systemInfo.ip === 'string' ? normalizeAddress(systemInfo.ip) : '';
  if (declared) return declared;
  if (Array.isArray(systemInfo.ipAddresses)) {
    for (const address of systemInfo.ipAddresses) {
      if (typeof address === 'string' && normalizeAddress(address)) return normalizeAddress(address);
    }
  }
  return '';
}

/** 窗口内每个桶的起点（UTC 对齐）；最多 200 个桶，防止异常参数撑爆响应。 */
export function buildTrendBuckets(from: Date, to: Date, bucket: AccessTrendBucketUnit): Date[] {
  const stepMs = bucket === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const start = new Date(from.getTime());
  if (bucket === 'day') start.setUTCHours(0, 0, 0, 0);
  else start.setUTCMinutes(0, 0, 0);
  const end = new Date(to.getTime());
  if (bucket === 'day') end.setUTCHours(0, 0, 0, 0);
  else end.setUTCMinutes(0, 0, 0);
  const buckets: Date[] = [];
  for (let cursor = start.getTime(); cursor <= end.getTime() && buckets.length < 200; cursor += stepMs) {
    buckets.push(new Date(cursor));
  }
  return buckets;
}

/** 基于端口 / 进程 / 目标层级的规则建议标签（优先级：运维工具 > 外部依赖 > 数据访问 > 中间件访问 > 应用调用）。 */
export function suggestedTrendTag(input: TrendSuggestionInput): string {
  const port = Math.floor(input.targetPort);
  const source = `${input.sourceService},${input.processes}`;
  if (OPS_PORTS.has(port) || OPS_PROCESS_PATTERN.test(source)) return '运维工具';
  if (input.targetAgentId === null) return '外部依赖';
  const targetService = input.targetService.trim();
  if (targetService && (DATA_PATTERN.test(targetService) || DATA_ES_PATTERN.test(targetService))) {
    return '数据访问';
  }
  if (targetService && MIDDLEWARE_PATTERN.test(targetService)) return '中间件访问';
  return '应用调用';
}

interface TrendGroup {
  readonly agentId: string;
  readonly sourceService: string;
  readonly processes: Set<string>;
  readonly peerAddress: string;
  readonly peerPort: number;
  readonly bucketOpened: Map<string, { opened: number; failed: number }>;
  totalOpened: number;
  totalFailed: number;
  lastSeen: Date | null;
}

/** 纯函数：SQL 单桶聚合行 → 趋势行（补零桶、解析主机/服务、建议标签、挂已有标签）。 */
export function buildAccessTrends(args: BuildAccessTrendsArgs): AccessTrendRow[] {
  const bucketStarts = buildTrendBuckets(args.from, args.to, args.bucket);
  const bucketKeys = bucketStarts.map((start) => start.toISOString());
  const agentsById = new Map(args.agents.map((agent) => [agent.id, agent]));
  const agentByIp = new Map<string, TrendAgentSource>();
  for (const agent of args.agents) {
    const declared = typeof agent.systemInfo.ip === 'string' ? normalizeAddress(agent.systemInfo.ip) : '';
    if (declared) agentByIp.set(declared, agent);
    if (Array.isArray(agent.systemInfo.ipAddresses)) {
      for (const address of agent.systemInfo.ipAddresses) {
        if (typeof address === 'string' && normalizeAddress(address)) agentByIp.set(normalizeAddress(address), agent);
      }
    }
  }
  const portServices = new Map<string, string>();
  for (const item of args.portServices) {
    const key = `${item.agentId}|${item.port}`;
    if (!portServices.has(key) || !portServices.get(key)) portServices.set(key, item.service);
  }
  const tagsByKey = new Map<string, TopologyEdgeTag[]>();
  for (const tag of args.tags ?? []) {
    const list = tagsByKey.get(tag.relationKey);
    if (list) list.push(tag);
    else tagsByKey.set(tag.relationKey, [tag]);
  }

  const groups = new Map<string, TrendGroup>();
  for (const row of args.rows) {
    const agentId = text(row.agentId, 80);
    const peerAddress = normalizeAddress(text(row.peerAddress, 160));
    if (!agentId || !peerAddress) continue;
    const sourceService = text(row.sourceService, 120) || 'unknown';
    const key = `${agentId}|${sourceService}|${peerAddress}|${Math.floor(numberFromDb(row.peerPort))}`;
    const group = groups.get(key) ?? {
      agentId,
      sourceService,
      processes: new Set<string>(),
      peerAddress,
      peerPort: Math.floor(numberFromDb(row.peerPort)),
      bucketOpened: new Map<string, { opened: number; failed: number }>(),
      totalOpened: 0,
      totalFailed: 0,
      lastSeen: null,
    };
    for (const process of text(row.processes, 200).split(',')) {
      const name = process.trim();
      if (name) group.processes.add(name);
    }
    const bucketKey = row.bucketStart.toISOString();
    const current = group.bucketOpened.get(bucketKey) ?? { opened: 0, failed: 0 };
    const opened = Math.max(0, Math.floor(numberFromDb(row.opened)));
    const failed = Math.max(0, Math.floor(numberFromDb(row.failed)));
    current.opened += opened;
    current.failed += failed;
    group.bucketOpened.set(bucketKey, current);
    group.totalOpened += opened;
    group.totalFailed += failed;
    if (row.lastSeen instanceof Date && !Number.isNaN(row.lastSeen.getTime())) {
      if (!group.lastSeen || row.lastSeen.getTime() > group.lastSeen.getTime()) group.lastSeen = row.lastSeen;
    }
    groups.set(key, group);
  }

  const rows: AccessTrendRow[] = [];
  for (const group of groups.values()) {
    const sourceAgent = agentsById.get(group.agentId);
    const sourceHost = sourceAgent?.hostname ?? group.agentId;
    const sourceIp = sourceAgent ? primaryIp(sourceAgent.systemInfo) : '';
    const targetAgent = agentByIp.get(group.peerAddress);
    const targetHost = targetAgent?.hostname ?? group.peerAddress;
    const targetIp = group.peerAddress;
    const relationKey = topologyRelationKey(sourceHost, targetHost, group.peerPort);
    const targetService = targetAgent
      ? portServices.get(`${targetAgent.id}|${group.peerPort}`) ?? ''
      : '';
    const processes = [...group.processes].join(',');
    const suggestedTag = suggestedTrendTag({
      targetPort: group.peerPort,
      sourceService: group.sourceService,
      processes,
      targetAgentId: targetAgent?.id ?? null,
      targetService,
    });
    const buckets: AccessTrendBucket[] = bucketKeys.map((bucketKey) => {
      const bucket = group.bucketOpened.get(bucketKey);
      return { start: bucketKey, opened: bucket?.opened ?? 0, failed: bucket?.failed ?? 0 };
    });
    const tags = tagsByKey.get(relationKey);
    rows.push({
      id: `trend:${relationKey}:${group.sourceService}`.slice(0, 400),
      relationKey,
      sourceAgentId: group.agentId,
      sourceHost,
      sourceService: group.sourceService,
      sourceIp,
      targetAgentId: targetAgent?.id ?? null,
      targetHost,
      targetIp,
      targetPort: group.peerPort,
      protocol: 'tcp',
      totalOpened: group.totalOpened,
      totalFailed: group.totalFailed,
      buckets,
      ...(group.lastSeen ? { lastSeen: group.lastSeen.toISOString() } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      suggestedTag,
    });
  }
  rows.sort((left, right) => right.totalOpened - left.totalOpened
    || left.relationKey.localeCompare(right.relationKey)
    || left.sourceService.localeCompare(right.sourceService));
  return rows.slice(0, Math.max(1, Math.min(args.limit ?? MAX_TREND_ROWS, MAX_TREND_ROWS)));
}

export interface AccessTrendOptions {
  readonly windowHours?: number;
  readonly bucket?: AccessTrendBucketUnit;
  readonly appSystemId?: string | null;
}

/** 访问量趋势查询服务：一次 SQL 聚合 out 样本 + 服务端补桶/解析/挂标签。 */
export class AccessTrendService {
  private readonly tags: TopologyEdgeTagService;

  constructor(private readonly pool: Pool, tags?: TopologyEdgeTagService) {
    this.tags = tags ?? new TopologyEdgeTagService(pool);
  }

  async get(tenantId: string, options: AccessTrendOptions = {}): Promise<AccessTrendsResponse> {
    const windowHours = options.windowHours === undefined ? 24 : options.windowHours;
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
      throw new AccessTrendError('invalid_window');
    }
    const bucket = options.bucket ?? 'hour';
    if (bucket !== 'hour' && bucket !== 'day') throw new AccessTrendError('invalid_bucket');
    const appSystemId = options.appSystemId ?? null;
    const to = new Date();
    const from = new Date(to.getTime() - windowHours * 60 * 60 * 1000);

    const raw = await this.pool.query<{
      agent_id: string;
      source_service: string;
      processes: string;
      peer_address: string;
      peer_port: number;
      bucket_start: Date;
      opened: string | number;
      failed: string | number;
      last_seen: Date | null;
    }>(
      `SELECT e.agent_id,
              COALESCE(NULLIF(e.service, ''), NULLIF(e.process, ''), 'unknown') AS source_service,
              string_agg(DISTINCT e.process, ',') AS processes,
              e.peer_address,
              e.peer_port,
              date_trunc($3::text, e.window_start) AS bucket_start,
              sum(e.opened)::bigint AS opened,
              sum(e.failed)::bigint AS failed,
              max(e.last_seen) AS last_seen
       FROM agent_connection_edges e
       JOIN agents a ON a.id = e.agent_id AND a.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1
         AND e.direction = 'out'
         AND e.window_start >= $4::timestamptz
         AND e.window_start <= $5::timestamptz
         AND ($2::uuid IS NULL OR a.app_system_id = $2)
       GROUP BY e.agent_id, source_service, e.peer_address, e.peer_port, bucket_start
       ORDER BY sum(e.opened) DESC
       LIMIT ${MAX_RAW_ROWS}`,
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
    const ports = await this.pool.query<{
      agent_id: string;
      name: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT agent_id, name, detail FROM agent_inventory
       WHERE tenant_id = $1 AND kind = 'port'`,
      [tenantId],
    );
    const portServices: TrendPortSource[] = [];
    for (const row of ports.rows) {
      const index = row.name.lastIndexOf(':');
      const port = index >= 0 ? Number.parseInt(row.name.slice(index + 1), 10) : 0;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      const service = text(row.detail.service, 120) || text(row.detail.process, 120);
      portServices.push({ agentId: row.agent_id, port, service });
    }
    const tags = await this.tags.list(tenantId);
    const rows = buildAccessTrends({
      rows: raw.rows.map((row) => ({
        agentId: row.agent_id,
        sourceService: row.source_service,
        processes: row.processes ?? '',
        peerAddress: row.peer_address,
        peerPort: row.peer_port,
        bucketStart: row.bucket_start,
        opened: numberFromDb(row.opened),
        failed: numberFromDb(row.failed),
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
      portServices,
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
