import type { Pool } from 'pg';

/**
 * Agent 心跳里的固定时间窗建连边表（connectionWindows）入库。
 *
 * 设计要点：
 * - 心跳只做「窗口样本落库」，不做聚合；聚合在拓扑学习会话窗口结束时进行；
 * - 同一窗口重发必须幂等：opened/closed/failed/active 取最新一次上报，
 *   baseline 取 OR、first_seen 取最小、last_seen 取最大；
 * - 校验失败的窗口/边直接忽略，绝不影响心跳主流程（心跳侧仍会 try/catch）。
 */

/** 心跳一次最多携带的窗口数（10s 一个窗口，约 2 分钟）。 */
export const MAX_CONNECTION_WINDOWS = 12;
/** 单个窗口最多接收的边数。 */
export const MAX_CONNECTION_EDGES_PER_WINDOW = 500;
/** 单条 SQL 最多写入的边数（控制参数个数与锁时间）。 */
const MAX_UPSERT_BATCH = 200;
/** 单个窗口的最大跨度，超出视为非法窗口（正常 10s）。 */
const MAX_WINDOW_SECONDS = 3600;
/** 计数类字段的防御上限。 */
const MAX_COUNT = 1_000_000;

const FIELD_LIMITS = {
  address: 160,
  process: 120,
  service: 120,
  command: 1000,
  container: 120,
  protocol: 20,
} as const;

/** 校验、截断后的窗口边样本（供 DB 批量 upsert）。 */
export interface NormalizedConnectionEdge {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly source: string;
  readonly direction: 'out' | 'in';
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
  readonly container: string;
  readonly baseline: boolean;
  readonly firstSeen: Date | null;
  readonly lastSeen: Date | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.floor(parsed), max);
}

function port(value: unknown): number {
  const parsed = integer(value, 65535);
  return parsed <= 65535 ? parsed : 0;
}

function pid(value: unknown): number {
  return integer(value, 2_147_483_647);
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 同一次上报里出现完全相同的唯一键时合并计数，避免 ON CONFLICT 同批冲突。 */
function mergeDuplicate(a: NormalizedConnectionEdge, b: NormalizedConnectionEdge): NormalizedConnectionEdge {
  const firstSeen = a.firstSeen && b.firstSeen ? new Date(Math.min(a.firstSeen.getTime(), b.firstSeen.getTime())) : (a.firstSeen ?? b.firstSeen);
  const lastSeen = a.lastSeen && b.lastSeen ? new Date(Math.max(a.lastSeen.getTime(), b.lastSeen.getTime())) : (a.lastSeen ?? b.lastSeen);
  return {
    ...a,
    opened: Math.min(a.opened + b.opened, MAX_COUNT),
    closed: Math.min(a.closed + b.closed, MAX_COUNT),
    failed: Math.min(a.failed + b.failed, MAX_COUNT),
    active: Math.min(a.active + b.active, MAX_COUNT),
    baseline: a.baseline || b.baseline,
    firstSeen,
    lastSeen,
  };
}

function edgeKey(edge: NormalizedConnectionEdge): string {
  return [
    edge.windowStart.toISOString(),
    edge.direction,
    edge.process,
    edge.pid,
    edge.localAddress,
    edge.localPort,
    edge.peerAddress,
    edge.peerPort,
  ].join('|');
}

/**
 * 把心跳里未知结构的 connectionWindows 规整为可入库的边样本：
 * 窗口数 ≤ 12、每窗口边 ≤ 500、字段截断、只接受 tcp、非法项忽略。
 */
export function normalizeConnectionWindows(value: unknown): NormalizedConnectionEdge[] {
  const windows = Array.isArray(value) ? value.slice(0, MAX_CONNECTION_WINDOWS) : [];
  const normalized: NormalizedConnectionEdge[] = [];
  for (const rawWindow of windows) {
    const window = asObject(rawWindow);
    if (!window) continue;
    const windowStart = timestamp(window.start);
    const windowEnd = timestamp(window.end);
    if (!windowStart || !windowEnd || windowEnd.getTime() <= windowStart.getTime()) continue;
    if (windowEnd.getTime() - windowStart.getTime() > MAX_WINDOW_SECONDS * 1000) continue;
    const source = text(window.source, 20) === 'ebpf'
      ? 'ebpf'
      : text(window.source, 20) === 'hybrid' ? 'hybrid' : 'procfs';
    const rawEdges = Array.isArray(window.edges) ? window.edges.slice(0, MAX_CONNECTION_EDGES_PER_WINDOW) : [];
    for (const rawEdge of rawEdges) {
      const edge = asObject(rawEdge);
      if (!edge) continue;
      const direction = edge.direction === 'in' ? 'in' : edge.direction === 'out' ? 'out' : null;
      if (!direction) continue;
      if (text(edge.protocol, FIELD_LIMITS.protocol).toLowerCase() !== 'tcp') continue;
      const peerAddress = text(edge.peerAddress, FIELD_LIMITS.address);
      const localAddress = text(edge.localAddress, FIELD_LIMITS.address);
      const peerPort = port(edge.peerPort);
      const localPort = port(edge.localPort);
      // Go Agent 的聚合口径：临时端口不参与聚合。
      // out 边 localPort=0、peerPort=目标服务端口；in 边 localPort=监听端口、peerPort=0。
      if (!peerAddress) continue;
      if (direction === 'out' && peerPort === 0) continue;
      if (direction === 'in' && localPort === 0) continue;
      const firstSeen = timestamp(edge.firstSeen);
      const lastSeen = timestamp(edge.lastSeen);
      normalized.push({
        windowStart,
        windowEnd,
        source,
        direction,
        process: text(edge.process, FIELD_LIMITS.process),
        pid: pid(edge.pid),
        service: text(edge.service, FIELD_LIMITS.service),
        command: text(edge.command, FIELD_LIMITS.command),
        localAddress,
        localPort,
        peerAddress,
        peerPort,
        protocol: 'tcp',
        opened: integer(edge.opened, MAX_COUNT),
        closed: integer(edge.closed, MAX_COUNT),
        failed: integer(edge.failed, MAX_COUNT),
        active: integer(edge.active, MAX_COUNT),
        container: text(edge.container, FIELD_LIMITS.container),
        baseline: edge.baseline === true,
        firstSeen,
        lastSeen,
      });
    }
  }
  const unique = new Map<string, NormalizedConnectionEdge>();
  for (const edge of normalized) {
    const key = edgeKey(edge);
    const current = unique.get(key);
    unique.set(key, current ? mergeDuplicate(current, edge) : edge);
  }
  return [...unique.values()];
}

/** Agent 建连边窗口样本入库服务。 */
export class AgentConnectionEdgeService {
  constructor(private readonly pool: Pool) {}

  /**
   * 入库一次心跳携带的窗口样本，返回接受的边数。
   * DB 异常会抛出，由心跳路由记录日志并继续返回心跳结果。
   */
  async sync(tenantId: string, agentId: string, windows: unknown): Promise<number> {
    const edges = normalizeConnectionWindows(windows);
    if (edges.length === 0) return 0;
    for (let offset = 0; offset < edges.length; offset += MAX_UPSERT_BATCH) {
      const batch = edges.slice(offset, offset + MAX_UPSERT_BATCH);
      await this.upsertBatch(tenantId, agentId, batch);
    }
    return edges.length;
  }

  private async upsertBatch(tenantId: string, agentId: string, edges: readonly NormalizedConnectionEdge[]): Promise<void> {
    const columnsPerRow = 23;
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
        edge.source,
        edge.direction,
        edge.process,
        edge.pid,
        edge.service,
        edge.command,
        edge.localAddress,
        edge.localPort,
        edge.peerAddress,
        edge.peerPort,
        edge.protocol,
        edge.opened,
        edge.closed,
        edge.failed,
        edge.active,
        edge.container,
        edge.baseline,
        edge.firstSeen,
        edge.lastSeen,
      );
    }
    await this.pool.query(
      `INSERT INTO agent_connection_edges
         (tenant_id, agent_id, window_start, window_end, source, direction, process, pid,
          service, command, local_address, local_port, peer_address, peer_port, protocol,
          opened, closed, failed, active, container, baseline, first_seen, last_seen)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (tenant_id, agent_id, window_start, direction, process, pid,
                    local_address, local_port, peer_address, peer_port)
       DO UPDATE SET opened = EXCLUDED.opened,
         closed = EXCLUDED.closed,
         failed = EXCLUDED.failed,
         active = EXCLUDED.active,
         baseline = agent_connection_edges.baseline OR EXCLUDED.baseline,
         first_seen = LEAST(agent_connection_edges.first_seen, EXCLUDED.first_seen),
         last_seen = GREATEST(agent_connection_edges.last_seen, EXCLUDED.last_seen),
         received_at = now()`,
      values,
    );
  }

  /** 删除超过保留期的窗口样本，返回删除行数（默认保留 7 天）。 */
  async purgeOlderThan(days = 7): Promise<number> {
    const keepDays = Math.min(Math.max(Math.floor(days), 1), 3650);
    const result = await this.pool.query(
      `DELETE FROM agent_connection_edges WHERE received_at < now() - make_interval(days => $1)`,
      [keepDays],
    );
    return result.rowCount ?? 0;
  }
}
