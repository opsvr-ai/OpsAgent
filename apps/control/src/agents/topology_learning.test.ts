import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { buildServer } from '../server.js';
import { AgentConnectionEdgeService } from './connection_edges.js';
import {
  buildGraphPayload,
  buildLearningInput,
  TopologyLearningService,
  type LearningAgentSource,
  type LearningEdgeSource,
  type LearningInventorySource,
  type TopologyAnalyzerLike,
} from './topology_learning.js';
import type { TopologyScope } from '@opsagent/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const tenantId = '00000000-0000-4000-8000-000000000001';
const windowStart = new Date('2026-11-10T04:00:00.000Z');
const windowEnd = new Date('2026-11-10T04:05:00.000Z');
const tenantScope: TopologyScope = { kind: 'tenant', appSystemId: null };

let dbAvailable = false;
try {
  const probe = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
  await probe.query('SELECT 1');
  await probe.end();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const agents: LearningAgentSource[] = [
  {
    id: 'agent-a',
    hostname: 'web-01',
    status: 'online',
    systemInfo: { ip: '10.0.1.11' },
    appSystemId: 'sys-1',
    appSystemName: '订单系统',
  },
  {
    id: 'agent-b',
    hostname: 'db-01',
    status: 'online',
    systemInfo: { ip: '10.0.2.21', ipAddresses: ['10.0.2.22'] },
    appSystemId: 'sys-1',
    appSystemName: '订单系统',
  },
  {
    id: 'agent-c',
    hostname: 'cache-01',
    status: 'online',
    systemInfo: { ip: '10.0.3.31' },
    appSystemId: 'sys-2',
    appSystemName: '缓存系统',
  },
  {
    id: 'agent-d',
    hostname: 'ops-01',
    status: 'offline',
    systemInfo: { ip: '10.0.4.41' },
    appSystemId: null,
    appSystemName: '',
  },
];

const inventory: LearningInventorySource[] = [
  {
    agentId: 'agent-a',
    kind: 'port',
    name: '0.0.0.0:8080',
    detail: { service: 'order-api', process: 'java', pid: 200 },
  },
  {
    agentId: 'agent-a',
    kind: 'process',
    name: 'java',
    detail: { command: '/opt/order/order-api.jar' },
  },
  {
    agentId: 'agent-b',
    kind: 'port',
    name: '0.0.0.0:3306',
    detail: { service: 'mysql', process: 'mysqld', pid: 100 },
  },
  {
    agentId: 'agent-c',
    kind: 'port',
    name: '0.0.0.0:6379',
    detail: { service: 'redis', process: 'redis-server', pid: 300 },
  },
];

function conn(overrides: Partial<LearningEdgeSource>): LearningEdgeSource {
  return {
    agentId: 'agent-a',
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
    ...overrides,
  };
}

const edges: LearningEdgeSource[] = [
  conn({}),
  conn({
    agentId: 'agent-b',
    direction: 'in',
    process: 'mysqld',
    pid: 100,
    service: 'mysql',
    command: '/usr/sbin/mysqld',
    localAddress: '0.0.0.0',
    localPort: 3306,
    peerAddress: '10.0.1.11',
    peerPort: 0,
  }),
  conn({
    peerAddress: '203.0.113.9',
    peerPort: 443,
    opened: 3,
    failed: 2,
    active: 0,
  }),
  conn({
    peerAddress: '10.0.9.9',
    peerPort: 6379,
    opened: 1,
    failed: 0,
    active: 0,
  }),
  conn({
    peerAddress: '10.0.3.31',
    peerPort: 6379,
    opened: 4,
    failed: 0,
    active: 1,
  }),
  // 未纳管来源的 inbound：应被丢弃，不能把未纳管客户端当主机。
  conn({
    agentId: 'agent-b',
    direction: 'in',
    localPort: 3306,
    peerAddress: '10.0.9.9',
    peerPort: 0,
    opened: 7,
  }),
  // 回环与同机内部流量：应被丢弃。
  conn({ peerAddress: '127.0.0.1', peerPort: 8080, opened: 2 }),
  conn({ peerAddress: '10.0.1.11', peerPort: 8080, opened: 2 }),
];

function learningInput(scope: TopologyScope = tenantScope) {
  return buildLearningInput({
    scope,
    windowStart,
    windowEnd,
    agents,
    inventory,
    edges,
    anomalies: new Map([['agent-b', ['critical: MySQL 连接数过高']]]),
  });
}

describe('buildLearningInput（窗口样本聚合纯函数）', () => {
  it('maps out edges to managed agents and resolves target listening service', () => {
    const input = learningInput();
    const managed = input.edges.find((edge) => edge.fromAgentId === 'agent-a' && edge.toAgentId === 'agent-b');
    expect(managed).toMatchObject({
      fromHost: 'web-01',
      fromService: 'order-api',
      toHost: 'db-01',
      toIp: '10.0.2.21',
      toPort: 3306,
      toService: 'mysql',
      direction: 'both',
    });
    expect(managed?.targetAppSystemId).toBe('sys-1');
    expect(managed?.targetAppSystemName).toBe('订单系统');
  });

  it('merges out/in observations into one edge, using out counters as the source of truth', () => {
    const input = learningInput();
    const merged = input.edges.find((edge) => edge.fromAgentId === 'agent-a' && edge.toAgentId === 'agent-b');
    expect(merged).toMatchObject({
      direction: 'both',
      opened: 5,
      closed: 1,
      failed: 1,
      active: 2,
      toService: 'mysql',
    });
    // 另一条 out 边（到缓存系统）与 it 独立。
    const cache = input.edges.find((edge) => edge.toAgentId === 'agent-c');
    expect(cache).toMatchObject({ toService: 'redis', direction: 'out', opened: 4 });
  });

  it('classifies unmanaged peers as external and notes public IPs', () => {
    const input = learningInput();
    const external = input.edges.filter((edge) => edge.toAgentId === null);
    expect(external).toHaveLength(2);
    expect(external.every((edge) => edge.external === true)).toBe(true);
    const publicPeer = input.externalPeers.find((peer) => peer.ip === '203.0.113.9');
    expect(publicPeer).toMatchObject({ port: 443, opened: 3, failed: 2, note: '公网 IP' });
    expect(publicPeer?.processes).toContain('java');
    const privatePeer = input.externalPeers.find((peer) => peer.ip === '10.0.9.9');
    expect(privatePeer).toMatchObject({ port: 6379, opened: 1, note: '未纳管' });
  });

  it('drops loopback, same-host and unmanaged inbound observations', () => {
    const input = learningInput();
    expect(input.edges.some((edge) => edge.toIp.startsWith('127.'))).toBe(false);
    expect(input.edges.some((edge) => edge.fromAgentId === 'agent-a' && edge.toIp === '10.0.1.11')).toBe(false);
    // 未纳管 inbound 不应生成 agent-b 的入边。
    expect(input.edges.some((edge) => edge.toAgentId === 'agent-b' && edge.fromAgentId !== 'agent-a')).toBe(false);
  });

  it('fills hosts, services, anomalies and window statistics', () => {
    const input = learningInput();
    expect(input.window).toEqual({
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      seconds: 300,
    });
    expect(input.stats).toEqual({
      nodeCount: 6,
      edgeCount: 4,
      hostCount: 4,
      systemCount: 2,
      externalCount: 2,
      totalConnections: 16,
      failedConnections: 3,
      samples: 8,
      reportingAgents: 2,
    });
    const db = input.hosts.find((host) => host.agentId === 'agent-b');
    expect(db?.services).toEqual([{ name: 'mysql', port: 3306, process: 'mysqld', pid: 100 }]);
    expect(db?.anomalies).toEqual(['critical: MySQL 连接数过高']);
    const web = input.hosts.find((host) => host.agentId === 'agent-a');
    expect(web?.services).toEqual([{ name: 'order-api', port: 8080, process: 'java', pid: 200 }]);
  });

  it('limits hosts to the app-system scope plus referenced peer hosts', () => {
    const scope: TopologyScope = { kind: 'app-system', appSystemId: 'sys-1', appSystemName: '订单系统' };
    const input = learningInput(scope);
    expect(input.hosts.map((host) => host.agentId).sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);
    expect(input.stats.hostCount).toBe(3);
    expect(input.scope).toEqual(scope);
  });

  it('keeps multiple services from one host to the same target port as separate edges', () => {
    const input = buildLearningInput({
      scope: tenantScope,
      windowStart,
      windowEnd,
      agents: agents.slice(0, 2),
      inventory,
      edges: [
        conn({ service: 'order-service', process: 'java', opened: 10, failed: 2, active: 1 }),
        conn({ service: 'order-worker', process: 'java', opened: 7, failed: 42, active: 0 }),
        conn({
          agentId: 'agent-b',
          direction: 'in',
          process: 'mysqld',
          pid: 100,
          service: 'mysql',
          localAddress: '0.0.0.0',
          localPort: 3306,
          peerAddress: '10.0.1.11',
          peerPort: 0,
          opened: 10,
          failed: 2,
          active: 1,
        }),
      ],
    });
    expect(input.edges).toHaveLength(2);
    const byService = new Map(input.edges.map((edge) => [edge.fromService, edge]));
    expect(byService.get('order-service')).toMatchObject({ opened: 10, failed: 2, direction: 'both' });
    expect(byService.get('order-worker')).toMatchObject({ opened: 7, failed: 42, direction: 'both' });
    // in 样本不重复累加计数。
    expect(input.stats.totalConnections).toBe(18);
    expect(input.stats.failedConnections).toBe(44);
  });
});

describe('buildGraphPayload（draft → 拓扑图纯函数）', () => {
  const input = learningInput();
  const generatedAt = new Date('2026-11-10T04:06:00.000Z');
  const draft = {
    nodes: [
      {
        id: 'h:web-01',
        label: 'web-01',
        kind: 'gateway' as const,
        tier: 'ingress' as const,
        hostname: 'web-01',
        ip: '10.0.1.11',
        appSystemId: 'sys-1',
        appSystemName: '订单系统',
        status: 'online' as const,
        services: [{ name: 'order-api', port: 8080 }],
      },
      {
        id: 'h:db-01',
        label: 'db-01',
        kind: 'database' as const,
        tier: 'data' as const,
        hostname: 'db-01',
        ip: '10.0.2.21',
        appSystemId: 'sys-1',
        appSystemName: '订单系统',
        status: 'online' as const,
      },
      {
        id: 'h:cache-01',
        label: 'cache-01',
        kind: 'cache' as const,
        tier: 'middleware' as const,
        hostname: 'cache-01',
        ip: '10.0.3.31',
        appSystemId: 'sys-2',
        appSystemName: '缓存系统',
        status: 'online' as const,
      },
      {
        id: 'x:203.0.113.9',
        label: '203.0.113.9',
        kind: 'external' as const,
        tier: 'external' as const,
        ip: '203.0.113.9',
        status: 'unknown' as const,
      },
    ],
    edges: [
      {
        source: 'h:web-01',
        target: 'h:db-01',
        port: 3306,
        count: 999,
        opened: 999,
        failed: 0,
        protocol: 'tcp',
        confidence: 0.92,
      },
      {
        source: 'h:web-01',
        target: 'x:203.0.113.9',
        port: 443,
        count: 1,
        opened: 1,
        failed: 0,
      },
    ],
    insights: [
      {
        id: 'i-1',
        title: '数据库访问',
        detail: 'web-01 → db-01:3306',
        severity: 'warning' as const,
        nodeIds: ['h:web-01', 'h:db-01'],
        edgeIds: ['e:h:web-01->h:db-01:3306'],
      },
    ],
    hotPaths: [
      {
        label: 'web-01 → db-01',
        nodeIds: ['h:web-01', 'h:db-01'],
        edgeIds: ['e:h:web-01->h:db-01:3306'],
        connections: 10,
      },
    ],
    risks: [],
    summary: '测试摘要',
    systems: [],
    confidence: 0.8,
  };

  const analysis = {
    summary: '测试摘要',
    insights: draft.insights,
    hotPaths: draft.hotPaths,
    risks: [],
    model: 'llm',
    promptVersion: 'topology-v1',
    generatedAt: generatedAt.toISOString(),
    confidence: 0.8,
  };

  it('keeps analyzer node ids and recomputes node metrics from input edges', () => {
    const payload = buildGraphPayload({ input, draft, analysis, generatedAt });
    expect(payload.nodes.map((node) => node.id)).toEqual([
      'h:web-01',
      'h:db-01',
      'h:cache-01',
      'x:203.0.113.9',
    ]);
    const web = payload.nodes.find((node) => node.id === 'h:web-01');
    expect(web?.metrics).toEqual({
      active: 3,
      opened: 13,
      closed: 4,
      failed: 3,
      inbound: 0,
      outbound: 13,
    });
    const db = payload.nodes.find((node) => node.id === 'h:db-01');
    expect(db?.metrics).toEqual({
      active: 2,
      opened: 5,
      closed: 1,
      failed: 1,
      inbound: 5,
      outbound: 0,
    });
    expect(payload.nodes.find((node) => node.id === 'x:203.0.113.9')?.metrics)
      .toMatchObject({ inbound: 3, opened: 3, failed: 2 });
  });

  it('uses analyzer edge id format and overrides model traffic with observed counts', () => {
    const payload = buildGraphPayload({ input, draft, analysis, generatedAt });
    const edge = payload.edges.find((item) => item.id === 'e:h:web-01->h:db-01:3306');
    expect(edge).toMatchObject({
      source: 'h:web-01',
      target: 'h:db-01',
      protocol: 'tcp',
      port: 3306,
      opened: 5,
      failed: 1,
      count: 7,
      countBasis: 'observed',
      direction: 'both',
      confidence: 0.92,
    });
    const external = payload.edges.find((item) => item.id === 'e:h:web-01->x:203.0.113.9:443');
    expect(external).toMatchObject({ external: true, opened: 3, failed: 2, count: 3 });
    expect(payload.analysis.model).toBe('llm');
    expect(payload.analysis.hotPaths[0]?.edgeIds).toEqual(['e:h:web-01->h:db-01:3306']);
    const edgeIds = new Set(payload.edges.map((item) => item.id));
    const referencedEdgeIds = [
      ...payload.analysis.insights.flatMap((insight) => insight.edgeIds ?? []),
      ...payload.analysis.hotPaths.flatMap((hotPath) => hotPath.edgeIds),
    ];
    expect(referencedEdgeIds.length).toBeGreaterThan(0);
    expect(referencedEdgeIds.every((id) => edgeIds.has(id))).toBe(true);
    expect(payload.edges.every((item) => typeof item.label === 'string' && item.label.length > 0)).toBe(true);
    expect(payload.stats).toMatchObject({ nodeCount: 4, edgeCount: 2, totalConnections: 10, failedConnections: 3 });
  });

  it('falls back to host-derived systems when analyzer returns none', () => {
    const payload = buildGraphPayload({ input, draft, analysis, generatedAt });
    expect(payload.systems).toEqual([
      { id: 'sys-1', name: '订单系统', nodeIds: ['h:web-01', 'h:db-01'] },
      { id: 'sys-2', name: '缓存系统', nodeIds: ['h:cache-01'] },
    ]);
  });

  it('excludes the unassigned group from systemCount but keeps it in systems[]', () => {
    const draftWithUnassigned = {
      ...draft,
      systems: [
        { id: 'sys-1', name: '订单系统', nodeIds: ['h:web-01', 'h:db-01'] },
        { id: 'unassigned', name: '未归属', nodeIds: ['x:203.0.113.9'] },
      ],
    };
    const payload = buildGraphPayload({ input, draft: draftWithUnassigned, analysis, generatedAt });
    expect(payload.systems).toHaveLength(2);
    expect(payload.stats.systemCount).toBe(1);
  });

  it('synthesizes a renderable graph when the analyzer returns an empty draft', () => {
    const payload = buildGraphPayload({
      input,
      draft: { nodes: [], edges: [] },
      analysis: { ...analysis, model: 'heuristic', fallback: true },
      generatedAt,
    });
    expect(payload.nodes.length).toBe(6);
    expect(payload.edges.length).toBe(4);
    expect(payload.edges.every((edge) => edge.id.includes('->'))).toBe(true);
    expect(payload.analysis.fallback).toBe(true);
    expect(payload.stats.nodeCount).toBe(6);
  });
});

const describeDb = dbAvailable ? describe : describe.skip;

describeDb('TopologyLearningService (postgres)', () => {
  let pool: Pool;
  let service: TopologyLearningService;
  let edgeService: AgentConnectionEdgeService;
  let appSystemId: string;
  let webId: string;
  let dbId: string;

  const stubAnalyzer: TopologyAnalyzerLike = {
    async analyze(_tenantId, input) {
      const nodeIdByAgent = new Map(input.hosts.map((host, index) => [host.agentId, `h:node-${index}`]));
      const nodes = input.hosts.map((host, index) => ({
        id: `h:node-${index}`,
        label: host.hostname,
        kind: 'service' as const,
        tier: 'app' as const,
        hostname: host.hostname,
        ip: host.ip,
        appSystemId: host.appSystemId,
        appSystemName: host.appSystemName,
        status: 'online' as const,
        services: host.services,
      }));
      const draftEdges = input.edges.flatMap((edge) => {
        const source = nodeIdByAgent.get(edge.fromAgentId);
        if (!source || !edge.toAgentId) return [];
        const target = nodeIdByAgent.get(edge.toAgentId);
        if (!target) return [];
        return [{
          source,
          target,
          port: edge.toPort,
          count: edge.opened + edge.active,
          opened: edge.opened,
          failed: edge.failed,
          protocol: 'tcp',
          confidence: 0.9,
        }];
      });
      const draftEdgeIds: string[] = [];
      for (const edge of draftEdges) draftEdgeIds.push(`e:${edge.source}->${edge.target}:${edge.port}`);
      const firstEdge = draftEdges[0];
      const firstEdgeId = draftEdgeIds[0];
      const insights = firstEdge && firstEdgeId
        ? [{
            id: 'i-1',
            title: 'stub 洞察',
            detail: 'stub 链路洞察',
            severity: 'info' as const,
            nodeIds: [firstEdge.source, firstEdge.target],
            edgeIds: [firstEdgeId],
          }]
        : [];
      const hotPaths = firstEdge && firstEdgeId
        ? [{
            label: 'stub 核心链路',
            nodeIds: [firstEdge.source, firstEdge.target],
            edgeIds: [firstEdgeId],
            connections: firstEdge.count,
          }]
        : [];
      return {
        draft: {
          nodes,
          edges: draftEdges,
          systems: [],
          insights,
          hotPaths,
          summary: 'stub 摘要',
          confidence: 0.8,
        },
        analysis: {
          summary: 'stub 分析摘要',
          insights,
          hotPaths,
          risks: [],
          model: 'heuristic',
          promptVersion: 'topology-v1',
          generatedAt: new Date().toISOString(),
          confidence: 0.8,
          fallback: true,
        },
      };
    },
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
    await seed(pool);
    await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [
      await hash('correct horse battery staple'),
      'tenant-admin',
    ]);
    const system = await pool.query<{ id: string }>(
      `INSERT INTO app_systems (tenant_id, code, name, criticality)
       VALUES ($1, 'learning-test', '学习测试系统', 'P1') RETURNING id`,
      [tenantId],
    );
    appSystemId = system.rows[0]?.id ?? '';
    const web = await pool.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, name, hostname, os, arch, version, agent_key, system_info, app_system_id)
       VALUES ($1, 'web-01', 'web-01', 'linux', 'amd64', '0.1.0', 'key-web', $2::jsonb, $3) RETURNING id`,
      [tenantId, JSON.stringify({ ip: '10.0.1.11' }), appSystemId],
    );
    webId = web.rows[0]?.id ?? '';
    const db = await pool.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, name, hostname, os, arch, version, agent_key, system_info, app_system_id)
       VALUES ($1, 'db-01', 'db-01', 'linux', 'amd64', '0.1.0', 'key-db', $2::jsonb, $3) RETURNING id`,
      [tenantId, JSON.stringify({ ip: '10.0.2.21' }), appSystemId],
    );
    dbId = db.rows[0]?.id ?? '';
    for (const [agentId, name, detail] of [
      [webId, '0.0.0.0:8080', { service: 'order-api', process: 'java', pid: 200 }],
      [dbId, '0.0.0.0:3306', { service: 'mysql', process: 'mysqld', pid: 100 }],
    ] as const) {
      await pool.query(
        `INSERT INTO agent_inventory (tenant_id, agent_id, kind, name, detail)
         VALUES ($1, $2, 'port', $3, $4::jsonb)`,
        [tenantId, agentId, name, JSON.stringify(detail)],
      );
    }
    edgeService = new AgentConnectionEdgeService(pool);
    service = new TopologyLearningService(pool, 'test-secret', stubAnalyzer);
  });

  afterAll(async () => {
    await pool.end();
  });

  function sampleWindows(mode: 'both' | 'out' | 'in' = 'both'): Array<Record<string, unknown>> {
    const start = new Date(Date.now() - 1000).toISOString();
    const end = new Date(Date.now() + 9000).toISOString();
    const outEdge = {
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
      firstSeen: start,
      lastSeen: end,
    };
    const inEdge = {
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
      firstSeen: start,
      lastSeen: end,
    };
    const edges = mode === 'both' ? [outEdge, inEdge] : [mode === 'out' ? outEdge : inEdge];
    return [{ start, end, source: 'procfs', edges }];
  }

  it('creates a collecting session, reuses active sessions and reports progress', async () => {
    const session = await service.start(
      tenantId,
      { appSystemId, windowSeconds: 120 },
      { requestedBy: null, trigger: 'manual' },
    );
    expect(session.status).toBe('collecting');
    expect(session.windowSeconds).toBe(120);
    expect(session.scope).toMatchObject({ kind: 'app-system', appSystemId, appSystemName: '学习测试系统' });
    expect(session.progress).toMatchObject({ percent: 0, expectedAgents: 2, phase: 'collecting' });

    const reused = await service.start(tenantId, { appSystemId, windowSeconds: 300 });
    expect(reused.id).toBe(session.id);
    expect(reused.windowSeconds).toBe(120);

    const acceptedOut = await edgeService.sync(tenantId, webId, sampleWindows('out'));
    const acceptedIn = await edgeService.sync(tenantId, dbId, sampleWindows('in'));
    expect(acceptedOut + acceptedIn).toBe(2);

    const progressed = await service.progress(tenantId, session.id);
    expect(progressed?.progress).toMatchObject({
      reportingAgents: 2,
      expectedAgents: 2,
      edgeSamples: 2,
      uniqueEdges: 2,
      phase: 'collecting',
    });
    expect(progressed?.progress.percent).toBeGreaterThanOrEqual(0);
    const active = await service.active(tenantId, appSystemId);
    expect(active?.id).toBe(session.id);
  });

  it('finalizes into a ready topology graph with v1 and graph id', async () => {
    const session = await service.active(tenantId, appSystemId);
    expect(session).not.toBeNull();
    // tick 会把到期 collecting 会话推进到 aggregating；这里直接模拟该状态后调用 finalize。
    await pool.query(
      `UPDATE topology_learning_sessions SET status = 'aggregating', updated_at = now() WHERE id = $1`,
      [session?.id],
    );
    const ready = await service.finalize(tenantId, session?.id ?? '');
    expect(ready?.status).toBe('ready');
    expect(ready?.graphId).toBeTruthy();
    expect(ready?.model).toBe('heuristic');
    expect(ready?.fallback).toBe(true);
    expect(ready?.stats).toMatchObject({ nodeCount: 2, edgeCount: 1, reportingAgents: 2 });

    const graph = await service.get(tenantId, ready?.graphId ?? '');
    expect(graph).not.toBeNull();
    expect(graph?.version).toBe(1);
    expect(graph?.nodes).toHaveLength(2);
    expect(graph?.edges).toHaveLength(1);
    const agentNodeIds = new Set(graph?.nodes.map((node) => node.id));
    expect(agentNodeIds.size).toBe(2);
    const edge = graph?.edges[0];
    expect(edge?.id).toMatch(/^e:h:node-\d+->h:node-\d+:3306$/);
    expect(edge).toMatchObject({
      protocol: 'tcp',
      port: 3306,
      opened: 5,
      failed: 1,
      direction: 'both',
      count: 7,
    });
    expect(graph?.analysis.summary).toBe('stub 分析摘要');
    expect(graph?.analysis.fallback).toBe(true);
    const graphEdgeIds = new Set(graph?.edges.map((item) => item.id));
    const referencedIds = [
      ...(graph?.analysis.insights.flatMap((insight) => insight.edgeIds ?? []) ?? []),
      ...(graph?.analysis.hotPaths.flatMap((hotPath) => hotPath.edgeIds) ?? []),
    ];
    expect(referencedIds.length).toBeGreaterThan(0);
    expect(referencedIds.every((id) => graphEdgeIds.has(id))).toBe(true);
    expect(graph?.analysis.hotPaths.every((hotPath) => hotPath.edgeIds.length > 0)).toBe(true);
    expect(graph?.edges.every((item) => typeof item.label === 'string' && item.label.length > 0)).toBe(true);
    expect(graph?.systems[0]?.nodeIds).toHaveLength(2);
    expect(graph?.analysis.confidence).toBe(0.8);
  });

  it('re-analyzes a ready session into a new graph version', async () => {
    const session = await service.active(tenantId, appSystemId);
    expect(session).toBeNull();
    const [latestBefore] = await service.list(tenantId);
    const ready = await service.get(tenantId, latestBefore?.id ?? '');
    expect(ready).not.toBeNull();
    const reanalyzed = await service.analyzeAgain(tenantId, latestBefore?.sessionId ?? '');
    expect(reanalyzed?.status).toBe('ready');
    expect(reanalyzed?.graphId).not.toBe(latestBefore?.id);
    const summaries = await service.list(tenantId);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.version).toBe(2);
    const latest = await service.latest(tenantId, appSystemId);
    expect(latest?.version).toBe(2);
    expect(latest?.id).toBe(summaries[0]?.id);
  });

  it('tick aggregates expired collecting sessions asynchronously', async () => {
    const session = await service.start(tenantId, { appSystemId, windowSeconds: 60 });
    await pool.query('UPDATE topology_learning_sessions SET ends_at = now() - interval \'1 second\' WHERE id = $1', [session.id]);
    const result = await service.tick({ autoLearn: false });
    expect(result.aggregated).toBeGreaterThanOrEqual(1);
    let current = await service.getSession(tenantId, session.id);
    for (let attempt = 0; attempt < 40 && current?.status !== 'ready' && current?.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      current = await service.getSession(tenantId, session.id);
    }
    expect(current?.status).toBe('ready');
  });

  it('fails analyzing sessions that exceed the analyzer timeout', async () => {
    const session = await service.start(tenantId, { appSystemId, windowSeconds: 60 });
    await pool.query(
      `UPDATE topology_learning_sessions
       SET status = 'analyzing', updated_at = now() - interval '11 minutes' WHERE id = $1`,
      [session.id],
    );
    const result = await service.tick({ autoLearn: false });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const failed = await service.getSession(tenantId, session.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('analyzer_timeout');
  });

  it('cancels an active learning session', async () => {
    const session = await service.start(tenantId, { appSystemId, windowSeconds: 60 });
    const cancelled = await service.cancel(tenantId, session.id);
    expect(cancelled?.status).toBe('cancelled');
    await expect(service.cancel(tenantId, session.id)).rejects.toThrow('session_not_cancellable');
  });

  it('runs due auto-learning policies with schedule trigger', async () => {
    const policy = await service.updatePolicy(tenantId, {
      enabled: true,
      intervalSeconds: 600,
      windowSeconds: 60,
      scope: { kind: 'app-system', appSystemId },
    });
    expect(policy).toMatchObject({ enabled: true, intervalSeconds: 600, windowSeconds: 60 });
    expect(policy.scope).toMatchObject({ kind: 'app-system', appSystemId });
    await pool.query(
      `UPDATE topology_learning_policies SET next_run_at = now() - interval '1 second' WHERE tenant_id = $1`,
      [tenantId],
    );
    const result = await service.tick({ autoLearn: true });
    expect(result.scheduled).toBe(1);
    const scheduled = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM topology_learning_sessions
       WHERE tenant_id = $1 AND trigger = 'schedule'`,
      [tenantId],
    );
    expect(scheduled.rows[0]?.count).toBe('1');
    const updated = await service.getPolicy(tenantId);
    expect(updated.lastRunAt).not.toBeNull();
    expect(updated.nextRunAt).not.toBeNull();
  });

  it('serves topology API with cookie auth and tenant permission', async () => {
    const app = buildServer({
      pool,
      localAdmin: { enabled: true, username: 'tenant-admin' },
      topologyLearning: service,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/local-admin',
      payload: { username: 'tenant-admin', password: 'correct horse battery staple' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    if (typeof cookie !== 'string') throw new Error('missing cookie');
    const headers = { cookie: cookie.split(';')[0] ?? '' };

    const unauthorized = await app.inject({ method: 'GET', url: '/api/topologies' });
    expect(unauthorized.statusCode).toBe(401);

    const list = await app.inject({ method: 'GET', url: '/api/topologies', headers });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray((list.json() as { graphs: unknown[] }).graphs)).toBe(true);

    const latest = await app.inject({ method: 'GET', url: `/api/topologies/latest?appSystemId=${appSystemId}`, headers });
    expect(latest.statusCode).toBe(200);
    expect((latest.json() as { version: number }).version).toBeGreaterThanOrEqual(2);

    const graphId = (latest.json() as { id: string }).id;
    const detail = await app.inject({ method: 'GET', url: `/api/topologies/${graphId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: graphId, mode: 'app-system' });

    const learn = await app.inject({
      method: 'POST',
      url: '/api/topologies/learn',
      headers,
      payload: { appSystemId, windowSeconds: 60 },
    });
    expect(learn.statusCode).toBe(201);
    const session = learn.json() as { id: string };
    const active = await app.inject({ method: 'GET', url: `/api/topologies/learn/active?appSystemId=${appSystemId}`, headers });
    expect((active.json() as { id: string }).id).toBe(session.id);

    const samples = await app.inject({
      method: 'POST',
      url: `/api/topologies/learn/${session.id}/samples`,
      headers,
      payload: { agentId: webId, windows: sampleWindows() },
    });
    expect(samples.statusCode).toBe(200);
    expect((samples.json() as { accepted: number }).accepted).toBe(2);

    const progress = await app.inject({ method: 'GET', url: `/api/topologies/learn/${session.id}`, headers });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({ status: 'collecting' });

    const policy = await app.inject({ method: 'GET', url: '/api/topologies/policy', headers });
    expect(policy.statusCode).toBe(200);
    const updatedPolicy = await app.inject({
      method: 'PUT',
      url: '/api/topologies/policy',
      headers,
      payload: { enabled: false },
    });
    expect(updatedPolicy.statusCode).toBe(200);
    expect((updatedPolicy.json() as { enabled: boolean }).enabled).toBe(false);

    const latestEmpty = await app.inject({
      method: 'GET',
      url: '/api/topologies/latest?appSystemId=00000000-0000-4000-8000-0000000000ff',
      headers,
    });
    expect(latestEmpty.statusCode).toBe(200);
    expect(latestEmpty.body).toBe('null');

    await app.close();
  });
});
