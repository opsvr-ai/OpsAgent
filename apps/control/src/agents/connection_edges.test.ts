import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import {
  AgentConnectionEdgeService,
  MAX_CONNECTION_EDGES_PER_WINDOW,
  MAX_CONNECTION_WINDOWS,
  normalizeConnectionWindows,
} from './connection_edges.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const tenantId = '00000000-0000-4000-8000-000000000001';

let dbAvailable = false;
try {
  const probe = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
  await probe.query('SELECT 1');
  await probe.end();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const describeDb = dbAvailable ? describe : describe.skip;

function edge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    direction: 'out',
    process: 'java',
    pid: 4123,
    service: 'order-api',
    command: '/opt/order/order-api.jar',
    localAddress: '10.0.1.11',
    localPort: 41234,
    peerAddress: '10.0.2.21',
    peerPort: 3306,
    protocol: 'tcp',
    opened: 3,
    closed: 2,
    failed: 0,
    active: 4,
    firstSeen: '2026-11-10T04:00:01.000Z',
    lastSeen: '2026-11-10T04:00:09.000Z',
    container: '',
    baseline: false,
    ...overrides,
  };
}

function window(edges: unknown[] = [edge()], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    start: '2026-11-10T04:00:00.000Z',
    end: '2026-11-10T04:00:10.000Z',
    source: 'procfs',
    edges,
    stats: { scans: 2, activeConnections: 4, dropped: 0 },
    ...overrides,
  };
}

describe('normalizeConnectionWindows', () => {
  it('accepts out edges with localPort=0 and in edges with peerPort=0', () => {
    const edges = normalizeConnectionWindows([
      window([
        edge({ direction: 'out', localPort: 0, peerPort: 3306 }),
        edge({
          direction: 'in',
          process: 'mysqld',
          pid: 100,
          service: 'mysql',
          localAddress: '0.0.0.0',
          localPort: 8080,
          peerAddress: '10.0.1.11',
          peerPort: 0,
        }),
      ]),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ direction: 'out', localPort: 0, peerPort: 3306 });
    expect(edges[1]).toMatchObject({ direction: 'in', localPort: 8080, peerPort: 0 });
  });

  it('caps windows at 12 and edges per window at 500', () => {
    const windows = Array.from({ length: MAX_CONNECTION_WINDOWS + 3 }, (_, windowIndex) => {
      const start = new Date(Date.UTC(2026, 10, 10, 4, 0, windowIndex)).toISOString();
      const end = new Date(Date.UTC(2026, 10, 10, 4, 0, windowIndex + 10)).toISOString();
      return window(
        Array.from({ length: MAX_CONNECTION_EDGES_PER_WINDOW + 10 }, (_, index) =>
          edge({ pid: index, localPort: 0, peerPort: 1000 + index })),
        { start, end },
      );
    });
    const edges = normalizeConnectionWindows(windows);
    expect(edges).toHaveLength(MAX_CONNECTION_WINDOWS * MAX_CONNECTION_EDGES_PER_WINDOW);
  });

  it('ignores non-tcp, invalid direction, missing peer and invalid windows', () => {
    const edges = normalizeConnectionWindows([
      window([
        edge({ protocol: 'udp' }),
        edge({ direction: 'inbound' }),
        edge({ peerAddress: '' }),
        edge({ direction: 'out', peerPort: 0 }),
        edge({ direction: 'in', localPort: 0 }),
        edge({ protocol: 'TCP', localPort: 0 }),
      ]),
      { start: 'not-a-date', end: '2026-11-10T04:00:10.000Z', edges: [edge()] },
      window([edge()], { end: '2026-11-10T04:00:00.000Z' }),
    ]);
    // 只保留最后一条协议大写 TCP 的 out 边（协议大小写不敏感）。
    expect(edges).toHaveLength(1);
    expect(edges[0]?.protocol).toBe('tcp');
  });

  it('truncates long text fields and clamps counters', () => {
    const [normalized] = normalizeConnectionWindows([
      window([edge({
        process: 'p'.repeat(500),
        service: 's'.repeat(500),
        command: 'c'.repeat(5000),
        container: 'k'.repeat(500),
        opened: -5,
        closed: 1.9,
        failed: Number.NaN,
        active: 1_000_000_000,
      })]),
    ]);
    expect(normalized?.process.length).toBe(120);
    expect(normalized?.service.length).toBe(120);
    expect(normalized?.command.length).toBe(1000);
    expect(normalized?.container.length).toBe(120);
    expect(normalized?.opened).toBe(0);
    expect(normalized?.closed).toBe(1);
    expect(normalized?.failed).toBe(0);
    expect(normalized?.active).toBe(1_000_000);
  });

  it('merges duplicate unique keys in one report (idempotent window resend)', () => {
    const duplicate = edge({ opened: 2, closed: 1, baseline: false, lastSeen: '2026-11-10T04:00:05.000Z' });
    const edges = normalizeConnectionWindows([window([edge(), duplicate])]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ opened: 5, closed: 3, active: 8 });
    expect(edges[0]?.lastSeen?.toISOString()).toBe('2026-11-10T04:00:09.000Z');
  });
});

describeDb('AgentConnectionEdgeService (postgres)', () => {
  let pool: Pool;
  let service: AgentConnectionEdgeService;
  let agentId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
    await seed(pool);
    service = new AgentConnectionEdgeService(pool);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, name, hostname, os, arch, version, agent_key)
       VALUES ($1, 'web-01', 'web-01', 'linux', 'amd64', '0.1.0', 'test-key')
       RETURNING id`,
      [tenantId],
    );
    agentId = inserted.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await pool.end();
  });

  function outInWindows(): Array<Record<string, unknown>> {
    return [
      window([
        edge({ direction: 'out', localPort: 0, peerPort: 3306 }),
        edge({
          direction: 'in',
          process: 'mysqld',
          pid: 100,
          service: 'mysql',
          localAddress: '0.0.0.0',
          localPort: 8080,
          peerAddress: '10.0.1.11',
          peerPort: 0,
        }),
      ]),
    ];
  }

  it('persists out/in edges from a heartbeat window', async () => {
    const accepted = await service.sync(tenantId, agentId, outInWindows());
    expect(accepted).toBe(2);
    const rows = await pool.query(
      `SELECT direction, local_port, peer_port, service FROM agent_connection_edges
       WHERE tenant_id = $1 AND agent_id = $2 ORDER BY direction`,
      [tenantId, agentId],
    );
    expect(rows.rows).toEqual([
      { direction: 'in', local_port: 8080, peer_port: 0, service: 'mysql' },
      { direction: 'out', local_port: 0, peer_port: 3306, service: 'order-api' },
    ]);
  });

  it('re-sending the same window updates counters instead of duplicating', async () => {
    const resent = window([
      edge({
        direction: 'out',
        localPort: 0,
        peerPort: 3306,
        opened: 9,
        closed: 4,
        failed: 2,
        active: 6,
        baseline: true,
        firstSeen: '2026-11-10T04:00:00.500Z',
        lastSeen: '2026-11-10T04:00:09.500Z',
      }),
    ]);
    await service.sync(tenantId, agentId, [resent]);
    const rows = await pool.query<{
      direction: string; opened: number; closed: number; failed: number; active: number;
      baseline: boolean; first_seen: Date; last_seen: Date;
    }>(
      `SELECT direction, opened, closed, failed, active, baseline, first_seen, last_seen
       FROM agent_connection_edges WHERE tenant_id = $1 AND agent_id = $2 AND direction = 'out'`,
      [tenantId, agentId],
    );
    const row = rows.rows[0];
    expect(rows.rows).toHaveLength(1);
    expect(row).toMatchObject({ opened: 9, closed: 4, failed: 2, active: 6, baseline: true });
    expect(row?.first_seen.toISOString()).toBe('2026-11-10T04:00:00.500Z');
    expect(row?.last_seen.toISOString()).toBe('2026-11-10T04:00:09.500Z');
  });

  it('purges samples older than the retention window', async () => {
    await pool.query(
      `UPDATE agent_connection_edges SET received_at = now() - interval '10 days'
       WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, agentId],
    );
    const purged = await service.purgeOlderThan(7);
    expect(purged).toBe(2);
    const remaining = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_connection_edges WHERE tenant_id = $1',
      [tenantId],
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });
});
