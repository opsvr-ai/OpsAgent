import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { buildServer } from '../server.js';
import {
  AgentHttpRequestService,
  HttpRequestTrendService,
  MAX_HTTP_REQUEST_EDGES,
  MAX_HTTP_REQUEST_WINDOWS,
  buildHttpRequestBuckets,
  buildHttpRequestTrends,
  normalizeHttpRequestWindows,
  type HttpRequestAggregateSource,
  type HttpRequestAgentSource,
} from './topology_http_requests.js';
import { TopologyEdgeTagService } from './topology_tags.js';

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

function httpEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    direction: 'out',
    protocol: 'http1',
    method: 'GET',
    localAddress: '10.0.1.11',
    localPort: 41234,
    peerAddress: '10.0.2.21',
    peerPort: 8080,
    service: 'order-api',
    requests: 10,
    errors: 1,
    firstSeen: '2026-11-11T04:00:01.000Z',
    lastSeen: '2026-11-11T04:00:09.000Z',
    ...overrides,
  };
}

function httpWindow(requests: unknown[] = [httpEdge()], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    start: '2026-11-11T04:00:00.000Z',
    end: '2026-11-11T04:00:10.000Z',
    source: 'userspace',
    requests,
    ...overrides,
  };
}

const from = new Date('2026-11-11T04:00:00.000Z');
const to = new Date('2026-11-11T06:00:00.000Z');
const agents: HttpRequestAgentSource[] = [
  { id: 'agent-a', hostname: 'web-01', systemInfo: { ip: '10.0.1.11' } },
  { id: 'agent-b', hostname: 'db-01', systemInfo: { ip: '10.0.2.21' } },
];

function aggregate(overrides: Partial<HttpRequestAggregateSource>): HttpRequestAggregateSource {
  return {
    agentId: 'agent-a',
    direction: 'out',
    protocol: 'http1',
    method: 'GET',
    service: 'order-api',
    peerAddress: '10.0.2.21',
    peerPort: 8080,
    bucketStart: new Date('2026-11-11T04:00:00.000Z'),
    requests: 10,
    errors: 1,
    lastSeen: new Date('2026-11-11T04:05:00.000Z'),
    ...overrides,
  };
}

describe('HTTP 请求窗口归一化', () => {
  it('accepts valid windows/edges and rejects invalid protocol/direction/address/port', () => {
    const edges = normalizeHttpRequestWindows([
      httpWindow([
        httpEdge(),
        httpEdge({ direction: 'inbound' }),
        httpEdge({ protocol: 'tls' }),
        httpEdge({ peerAddress: '' }),
        httpEdge({ peerPort: 0 }),
        httpEdge({ protocol: 'grpc', method: 'post', requests: 3.9, errors: -1 }),
      ]),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ protocol: 'http1', method: 'GET', requests: 10, errors: 1 });
    expect(edges[1]).toMatchObject({ protocol: 'grpc', method: 'POST', requests: 3, errors: 0 });
  });

  it('caps windows at 10 and edges per window at 200', () => {
    const windows = Array.from({ length: MAX_HTTP_REQUEST_WINDOWS + 2 }, (_, index) => {
      const start = new Date(Date.UTC(2026, 10, 11, 4, 0, index)).toISOString();
      const end = new Date(Date.UTC(2026, 10, 11, 4, 0, index + 10)).toISOString();
      return httpWindow(
        Array.from({ length: MAX_HTTP_REQUEST_EDGES + 5 }, (_, edgeIndex) =>
          httpEdge({ method: `M${edgeIndex}`, peerPort: 1000 + edgeIndex })),
        { start, end },
      );
    });
    expect(normalizeHttpRequestWindows(windows)).toHaveLength(
      MAX_HTTP_REQUEST_WINDOWS * MAX_HTTP_REQUEST_EDGES,
    );
  });

  it('truncates text fields and merges duplicate unique keys within one report', () => {
    const edges = normalizeHttpRequestWindows([
      httpWindow([
        httpEdge({ method: 'm'.repeat(50), service: 's'.repeat(300), requests: 2, errors: 1 }),
        httpEdge({ method: 'M'.repeat(50), service: 's'.repeat(300), requests: 3, errors: 2 }),
      ]),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.method.length).toBe(20);
    expect(edges[0]?.service.length).toBe(120);
    expect(edges[0]).toMatchObject({ requests: 5, errors: 3 });
  });
});

describe('HTTP 请求趋势纯函数', () => {
  it('builds UTC-aligned hour/day buckets', () => {
    const hours = buildHttpRequestBuckets(
      new Date('2026-11-11T04:30:00.000Z'),
      new Date('2026-11-11T06:10:00.000Z'),
      'hour',
    );
    expect(hours.map((bucket) => bucket.toISOString())).toEqual([
      '2026-11-11T04:00:00.000Z',
      '2026-11-11T05:00:00.000Z',
      '2026-11-11T06:00:00.000Z',
    ]);
  });

  it('aggregates dims, fills zero buckets, resolves targets and attaches tags', () => {
    const rows = buildHttpRequestTrends({
      rows: [
        aggregate({}),
        aggregate({ bucketStart: new Date('2026-11-11T05:00:00.000Z'), requests: 5, errors: 2 }),
        aggregate({
          protocol: 'grpc',
          method: 'POST',
          service: 'pay-api',
          peerAddress: '10.0.3.31',
          peerPort: 50051,
          requests: 7,
          errors: 0,
          bucketStart: new Date('2026-11-11T04:00:00.000Z'),
        }),
      ],
      bucket: 'hour',
      from,
      to,
      agents,
      tags: [{ id: 'tag-1', relationKey: 'web-01|db-01|8080', label: '核心链路', source: 'user' }],
    });
    expect(rows).toHaveLength(2);
    const httpRow = rows.find((row) => row.protocol === 'http1');
    expect(httpRow).toMatchObject({
      relationKey: 'web-01|db-01|8080',
      sourceAgentId: 'agent-a',
      sourceHost: 'web-01',
      sourceService: 'order-api',
      sourceIp: '10.0.1.11',
      targetAgentId: 'agent-b',
      targetHost: 'db-01',
      targetIp: '10.0.2.21',
      targetPort: 8080,
      method: 'GET',
      totalRequests: 15,
      totalErrors: 3,
    });
    expect(httpRow?.buckets.map((bucket) => [bucket.start, bucket.requests, bucket.errors])).toEqual([
      ['2026-11-11T04:00:00.000Z', 10, 1],
      ['2026-11-11T05:00:00.000Z', 5, 2],
      ['2026-11-11T06:00:00.000Z', 0, 0],
    ]);
    expect(httpRow?.tags?.map((tag) => tag.label)).toEqual(['核心链路']);
    expect(httpRow?.lastSeen).toBe('2026-11-11T04:05:00.000Z');
    const grpcRow = rows.find((row) => row.protocol === 'grpc');
    expect(grpcRow).toMatchObject({ targetAgentId: null, targetHost: '10.0.3.31', targetPort: 50051 });
    expect(rows[0]?.totalRequests).toBeGreaterThanOrEqual(rows[1]?.totalRequests ?? 0);
  });
});

const describeDb = dbAvailable ? describe : describe.skip;

describeDb('AgentHttpRequestService (postgres)', () => {
  let pool: Pool;
  let service: AgentHttpRequestService;
  let trendService: HttpRequestTrendService;
  let tagService: TopologyEdgeTagService;
  let agentId: string;
  let appSystemId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
    await seed(pool);
    const system = await pool.query<{ id: string }>(
      `INSERT INTO app_systems (tenant_id, code, name) VALUES ($1, 'http-test', 'HTTP测试系统') RETURNING id`,
      [tenantId],
    );
    appSystemId = system.rows[0]?.id ?? '';
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, name, hostname, os, arch, version, agent_key, system_info, app_system_id)
       VALUES ($1, 'web-01', 'web-01', 'linux', 'amd64', '0.1.0', 'http-key', $2::jsonb, $3) RETURNING id`,
      [tenantId, JSON.stringify({ ip: '10.0.1.11' }), appSystemId],
    );
    agentId = agent.rows[0]?.id ?? '';
    await pool.query(
      `INSERT INTO agents (tenant_id, name, hostname, os, arch, version, agent_key, system_info, app_system_id)
       VALUES ($1, 'db-01', 'db-01', 'linux', 'amd64', '0.1.0', 'http-key-db', $2::jsonb, $3)`,
      [tenantId, JSON.stringify({ ip: '10.0.2.21' }), appSystemId],
    );
    service = new AgentHttpRequestService(pool);
    tagService = new TopologyEdgeTagService(pool);
    trendService = new HttpRequestTrendService(pool, tagService);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('persists HTTP request windows idempotently', async () => {
    const accepted = await service.sync(tenantId, agentId, [httpWindow()]);
    expect(accepted).toBe(1);
    const resent = await service.sync(tenantId, agentId, [
      httpWindow([httpEdge({ requests: 20, errors: 4 })]),
    ]);
    expect(resent).toBe(1);
    const rows = await pool.query<{ requests: number; errors: number; service: string }>(
      'SELECT requests, errors, service FROM agent_http_requests WHERE tenant_id = $1',
      [tenantId],
    );
    expect(rows.rows).toEqual([{ requests: 20, errors: 4, service: 'order-api' }]);
  });

  it('purges HTTP request rows older than the retention window', async () => {
    await pool.query(
      `UPDATE agent_http_requests SET received_at = now() - interval '10 days' WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(await service.purgeOlderThan(7)).toBe(1);
    const rows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_http_requests WHERE tenant_id = $1',
      [tenantId],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('aggregates trends from stored samples and attaches tags', async () => {
    const start = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await service.sync(tenantId, agentId, [{
      start,
      end,
      source: 'userspace',
      requests: [
        httpEdge({ requests: 12, errors: 2, firstSeen: start, lastSeen: end }),
        httpEdge({ protocol: 'http2', method: 'POST', requests: 3, errors: 0, firstSeen: start, lastSeen: end }),
      ],
    }]);
    await tagService.create(tenantId, {
      relationKey: 'web-01|db-01|8080',
      label: '核心接口',
      category: '应用调用',
      source: 'model',
    }, null);
    const response = await trendService.get(tenantId, {
      windowHours: 24,
      bucket: 'hour',
      appSystemId,
    });
    expect(response).toMatchObject({ windowSeconds: 86400, bucket: 'hour' });
    expect(response.rows.length).toBe(2);
    const http1Row = response.rows.find((row) => row.protocol === 'http1');
    expect(http1Row).toMatchObject({
      relationKey: 'web-01|db-01|8080',
      targetHost: 'db-01',
      totalRequests: 12,
      totalErrors: 2,
    });
    expect(http1Row?.tags?.map((tag) => tag.label)).toEqual(['核心接口']);
    expect(http1Row?.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(12);
    const otherScope = await trendService.get(tenantId, {
      windowHours: 24,
      bucket: 'hour',
      appSystemId: '00000000-0000-4000-8000-0000000000ff',
    });
    expect(otherScope.rows).toEqual([]);
    await expect(trendService.get(tenantId, { windowHours: 0 })).rejects.toThrow('invalid_window');
    await expect(trendService.get(tenantId, { bucket: 'minute' as 'hour' })).rejects.toThrow('invalid_bucket');
  });

  it('ingests httpRequestWindows from the heartbeat without blocking on bad payloads', async () => {
    const app = buildServer({ pool });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/heartbeat`,
        payload: {
          agentKey: 'http-key',
          httpRequestWindows: [httpWindow([
            httpEdge({ method: 'PUT', requests: 7, errors: 1, service: 'heartbeat-api' }),
          ])],
        },
      });
      expect(ok.statusCode).toBe(200);
      const rows = await pool.query<{ requests: number; service: string }>(
        `SELECT requests, service FROM agent_http_requests
         WHERE tenant_id = $1 AND method = 'PUT'`,
        [tenantId],
      );
      expect(rows.rows).toEqual([{ requests: 7, service: 'heartbeat-api' }]);

      const badPayload = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/heartbeat`,
        payload: { agentKey: 'http-key', httpRequestWindows: 'not-an-array' },
      });
      expect(badPayload.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
