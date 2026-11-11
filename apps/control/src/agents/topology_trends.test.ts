import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { AgentConnectionEdgeService } from './connection_edges.js';
import {
  AccessTrendService,
  buildAccessTrends,
  buildTrendBuckets,
  suggestedTrendTag,
  type TrendAgentSource,
  type TrendAggregateSource,
  type TrendPortSource,
} from './topology_trends.js';
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

const from = new Date('2026-11-11T10:00:00.000Z');
const to = new Date('2026-11-11T12:00:00.000Z');

const agents: TrendAgentSource[] = [
  { id: 'agent-a', hostname: 'web-01', systemInfo: { ip: '10.0.1.11' } },
  { id: 'agent-b', hostname: 'db-01', systemInfo: { ip: '10.0.2.21' } },
  { id: 'agent-c', hostname: 'cache-01', systemInfo: { ip: '10.0.3.31' } },
  { id: 'agent-d', hostname: 'data-01', systemInfo: { ip: '10.0.4.41' } },
];

const portServices: TrendPortSource[] = [
  { agentId: 'agent-b', port: 3306, service: 'mysql' },
  { agentId: 'agent-c', port: 6379, service: 'redis' },
  { agentId: 'agent-d', port: 5432, service: 'postgres' },
];

function row(overrides: Partial<TrendAggregateSource>): TrendAggregateSource {
  return {
    agentId: 'agent-a',
    sourceService: 'order-api',
    processes: 'java',
    peerAddress: '10.0.2.21',
    peerPort: 3306,
    bucketStart: new Date('2026-11-11T10:00:00.000Z'),
    opened: 5,
    failed: 1,
    lastSeen: new Date('2026-11-11T10:55:00.000Z'),
    ...overrides,
  };
}

describe('访问量趋势纯函数', () => {
  it('builds UTC-aligned buckets for hour/day windows', () => {
    const hours = buildTrendBuckets(
      new Date('2026-11-11T10:30:00.000Z'),
      new Date('2026-11-11T12:10:00.000Z'),
      'hour',
    );
    expect(hours.map((bucket) => bucket.toISOString())).toEqual([
      '2026-11-11T10:00:00.000Z',
      '2026-11-11T11:00:00.000Z',
      '2026-11-11T12:00:00.000Z',
    ]);
    const days = buildTrendBuckets(
      new Date('2026-11-09T10:30:00.000Z'),
      new Date('2026-11-11T12:10:00.000Z'),
      'day',
    );
    expect(days.map((bucket) => bucket.toISOString())).toEqual([
      '2026-11-09T00:00:00.000Z',
      '2026-11-10T00:00:00.000Z',
      '2026-11-11T00:00:00.000Z',
    ]);
  });

  it('aggregates raw bucket rows, fills empty buckets and resolves hosts/services', () => {
    const rows = buildAccessTrends({
      rows: [
        row({}),
        row({ bucketStart: new Date('2026-11-11T11:00:00.000Z'), opened: 7, failed: 2 }),
        row({
          sourceService: 'sshd',
          processes: 'sshd',
          peerPort: 22,
          opened: 1,
          failed: 0,
          bucketStart: new Date('2026-11-11T10:00:00.000Z'),
        }),
        row({
          sourceService: 'cache-client',
          processes: 'java',
          peerAddress: '10.0.3.31',
          peerPort: 6379,
          opened: 4,
          failed: 0,
        }),
        row({
          sourceService: 'data-client',
          processes: 'java',
          peerAddress: '10.0.4.41',
          peerPort: 5432,
          opened: 2,
          failed: 0,
        }),
        row({
          sourceService: 'api-client',
          processes: 'java',
          peerAddress: '203.0.113.9',
          peerPort: 443,
          opened: 3,
          failed: 1,
        }),
      ],
      bucket: 'hour',
      from,
      to,
      agents,
      portServices,
      tags: [{ id: 'tag-1', relationKey: 'web-01|db-01|3306', label: '核心链路', source: 'user' }],
    });
    expect(rows).toHaveLength(5);
    const dbRow = rows.find((item) => item.relationKey === 'web-01|db-01|3306');
    expect(dbRow).toMatchObject({
      sourceAgentId: 'agent-a',
      sourceHost: 'web-01',
      sourceService: 'order-api',
      sourceIp: '10.0.1.11',
      targetAgentId: 'agent-b',
      targetHost: 'db-01',
      targetIp: '10.0.2.21',
      targetPort: 3306,
      protocol: 'tcp',
      totalOpened: 12,
      totalFailed: 3,
      suggestedTag: '数据访问',
    });
    expect(dbRow?.buckets.map((bucket) => [bucket.start, bucket.opened, bucket.failed])).toEqual([
      ['2026-11-11T10:00:00.000Z', 5, 1],
      ['2026-11-11T11:00:00.000Z', 7, 2],
      ['2026-11-11T12:00:00.000Z', 0, 0],
    ]);
    expect(dbRow?.tags?.map((tag) => tag.label)).toEqual(['核心链路']);
    expect(dbRow?.lastSeen).toBe('2026-11-11T10:55:00.000Z');
    // 默认按 totalOpened 降序。
    expect(rows[0]?.relationKey).toBe('web-01|db-01|3306');

    const sshRow = rows.find((item) => item.targetPort === 22);
    expect(sshRow?.suggestedTag).toBe('运维工具');
    const cacheRow = rows.find((item) => item.targetPort === 6379);
    expect(cacheRow?.suggestedTag).toBe('中间件访问');
    const externalRow = rows.find((item) => item.targetAgentId === null);
    expect(externalRow).toMatchObject({
      relationKey: 'web-01|203.0.113.9|443',
      targetHost: '203.0.113.9',
      suggestedTag: '外部依赖',
    });
  });

  it('suggests tags by ops port/process, unmanaged peer, data and middleware targets', () => {
    expect(suggestedTrendTag({
      targetPort: 22,
      sourceService: 'order-api',
      processes: 'java',
      targetAgentId: 'agent-b',
      targetService: '',
    })).toBe('运维工具');
    expect(suggestedTrendTag({
      targetPort: 8080,
      sourceService: 'zabbix_agent2',
      processes: 'zabbix_agent2',
      targetAgentId: 'agent-b',
      targetService: '',
    })).toBe('运维工具');
    expect(suggestedTrendTag({
      targetPort: 5432,
      sourceService: 'order-api',
      processes: 'java',
      targetAgentId: null,
      targetService: 'postgres',
    })).toBe('外部依赖');
    expect(suggestedTrendTag({
      targetPort: 3306,
      sourceService: 'order-api',
      processes: 'java',
      targetAgentId: 'agent-b',
      targetService: 'mysql',
    })).toBe('数据访问');
    expect(suggestedTrendTag({
      targetPort: 6379,
      sourceService: 'order-api',
      processes: 'java',
      targetAgentId: 'agent-c',
      targetService: 'redis',
    })).toBe('中间件访问');
    expect(suggestedTrendTag({
      targetPort: 8080,
      sourceService: 'order-api',
      processes: 'java',
      targetAgentId: 'agent-b',
      targetService: 'order-service',
    })).toBe('应用调用');
  });
});

const describeDb = dbAvailable ? describe : describe.skip;

describeDb('AccessTrendService (postgres)', () => {
  let pool: Pool;
  let service: AccessTrendService;
  let edgeService: AgentConnectionEdgeService;
  let tagService: TopologyEdgeTagService;
  let appSystemId: string;
  let webId: string;
  let dbId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
    await seed(pool);
    const system = await pool.query<{ id: string }>(
      `INSERT INTO app_systems (tenant_id, code, name) VALUES ($1, 'trend-test', '趋势测试系统') RETURNING id`,
      [tenantId],
    );
    appSystemId = system.rows[0]?.id ?? '';
    const web = await pool.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, name, hostname, os, arch, version, agent_key, system_info, app_system_id)
       VALUES ($1, 'web-01', 'web-01', 'linux', 'amd64', '0.1.0', 'trend-web', $2::jsonb, $3) RETURNING id`,
      [tenantId, JSON.stringify({ ip: '10.0.1.11' }), appSystemId],
    );
    webId = web.rows[0]?.id ?? '';
    const db = await pool.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, name, hostname, os, arch, version, agent_key, system_info, app_system_id)
       VALUES ($1, 'db-01', 'db-01', 'linux', 'amd64', '0.1.0', 'trend-db', $2::jsonb, $3) RETURNING id`,
      [tenantId, JSON.stringify({ ip: '10.0.2.21' }), appSystemId],
    );
    dbId = db.rows[0]?.id ?? '';
    await pool.query(
      `INSERT INTO agent_inventory (tenant_id, agent_id, kind, name, detail)
       VALUES ($1, $2, 'port', '0.0.0.0:3306', $3::jsonb)`,
      [tenantId, dbId, JSON.stringify({ service: 'mysql', process: 'mysqld', pid: 100 })],
    );
    edgeService = new AgentConnectionEdgeService(pool);
    tagService = new TopologyEdgeTagService(pool);
    service = new AccessTrendService(pool, tagService);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('aggregates out edges only, fills buckets and attaches tags', async () => {
    const start = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 60 * 1000).toISOString();
    await edgeService.sync(tenantId, webId, [{
      start,
      end,
      source: 'procfs',
      edges: [
        {
          direction: 'out',
          process: 'java',
          pid: 200,
          service: 'order-api',
          command: '/opt/order/order-api.jar',
          localAddress: '10.0.1.11',
          localPort: 0,
          peerAddress: '10.0.2.21',
          peerPort: 3306,
          protocol: 'tcp',
          opened: 5,
          closed: 1,
          failed: 1,
          active: 2,
        },
        {
          // in 样本不应计入趋势（否则会重复计数）。
          direction: 'in',
          process: 'mysqld',
          pid: 100,
          service: 'mysql',
          command: '/usr/sbin/mysqld',
          localAddress: '0.0.0.0',
          localPort: 3306,
          peerAddress: '10.0.1.11',
          peerPort: 0,
          protocol: 'tcp',
          opened: 5,
          closed: 1,
          failed: 1,
          active: 2,
        },
      ],
    }]);
    await tagService.create(tenantId, {
      relationKey: 'web-01|db-01|3306',
      label: '核心链路',
      category: '数据访问',
    }, null);

    const response = await service.get(tenantId, { windowHours: 24, bucket: 'hour', appSystemId });
    expect(response).toMatchObject({ windowSeconds: 86400, bucket: 'hour' });
    expect(response.rows).toHaveLength(1);
    const row = response.rows[0];
    expect(row).toMatchObject({
      relationKey: 'web-01|db-01|3306',
      sourceHost: 'web-01',
      sourceService: 'order-api',
      sourceIp: '10.0.1.11',
      targetAgentId: dbId,
      targetHost: 'db-01',
      targetPort: 3306,
      totalOpened: 5,
      totalFailed: 1,
      suggestedTag: '数据访问',
    });
    expect(row?.tags?.map((tag) => tag.label)).toEqual(['核心链路']);
    expect(row?.buckets.length).toBeGreaterThanOrEqual(24);
    expect(row?.buckets.reduce((sum, bucket) => sum + bucket.opened, 0)).toBe(5);
    expect(row?.id).toBe('trend:web-01|db-01|3306:order-api');

    const otherScope = await service.get(tenantId, {
      windowHours: 24,
      bucket: 'hour',
      appSystemId: '00000000-0000-4000-8000-0000000000ff',
    });
    expect(otherScope.rows).toEqual([]);
  });

  it('validates window and bucket options', async () => {
    await expect(service.get(tenantId, { windowHours: 0 })).rejects.toThrow('invalid_window');
    await expect(service.get(tenantId, { windowHours: 169 })).rejects.toThrow('invalid_window');
    await expect(service.get(tenantId, { bucket: 'minute' as 'hour' })).rejects.toThrow('invalid_bucket');
  });
});
