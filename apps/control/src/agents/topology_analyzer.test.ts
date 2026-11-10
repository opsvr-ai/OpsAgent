import { describe, expect, it } from 'vitest';
import type {
  TopologyDraft,
  TopologyExternalPeer,
  TopologyLearningEdge,
  TopologyLearningHost,
  TopologyLearningInput,
} from '@opsagent/contracts';
import type { CompletionRequest, ModelCompletionService } from '../models/completion.js';
import {
  DEFAULT_MODEL_LABEL,
  TOPOLOGY_FALLBACK_WARNING,
  TOPOLOGY_PROMPT_VERSION,
  TopologyAnalyzer,
  buildHeuristicDraft,
  buildTopologyPrompt,
  classifyManagedHost,
  topologyEdgeId,
} from './topology_analyzer.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const AGENT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const AGENT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const AGENT_C = 'cccccccc-0000-4000-8000-000000000003';
const ID_A = 'h:aaaaaaaa';
const ID_B = 'h:bbbbbbbb';
const ID_C = 'h:cccccccc';
const EXTERNAL_IP = '203.0.113.9';
const EXTERNAL_ID = `x:${EXTERNAL_IP}`;

function host(
  input: Partial<TopologyLearningHost> & Pick<TopologyLearningHost, 'agentId' | 'hostname'>,
): TopologyLearningHost {
  return {
    ip: '',
    appSystemId: null,
    appSystemName: '',
    status: 'online',
    services: [],
    anomalies: [],
    ...input,
  };
}

function link(
  input: Partial<TopologyLearningEdge> &
    Pick<TopologyLearningEdge, 'fromAgentId' | 'fromHost' | 'toHost' | 'toPort'>,
): TopologyLearningEdge {
  return {
    fromService: 'app',
    fromProcess: 'java',
    toAgentId: null,
    toIp: '',
    toService: '',
    direction: 'out',
    opened: 0,
    closed: 0,
    failed: 0,
    active: 0,
    protocol: 'tcp',
    ...input,
  };
}

function peer(input: Partial<TopologyExternalPeer> & Pick<TopologyExternalPeer, 'ip'>): TopologyExternalPeer {
  return {
    port: 443,
    processes: [],
    opened: 0,
    failed: 0,
    ...input,
  };
}

function makeInput(options: {
  hosts: TopologyLearningHost[];
  edges?: TopologyLearningEdge[];
  externalPeers?: TopologyExternalPeer[];
}): TopologyLearningInput {
  const edges = options.edges ?? [];
  const externalPeers = options.externalPeers ?? [];
  const hosts = options.hosts;
  const systems = new Set(
    hosts
      .map((item) => item.appSystemId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  return {
    scope: { kind: 'tenant' },
    window: {
      start: '2026-11-10T00:00:00.000Z',
      end: '2026-11-10T00:05:00.000Z',
      seconds: 300,
    },
    hosts,
    edges,
    externalPeers,
    stats: {
      nodeCount: hosts.length,
      edgeCount: edges.length,
      hostCount: hosts.length,
      systemCount: systems.size,
      externalCount: externalPeers.length,
      totalConnections: edges.reduce((sum, edge) => sum + edge.opened + edge.active, 0),
      failedConnections: edges.reduce((sum, edge) => sum + edge.failed, 0),
      samples: edges.length,
      reportingAgents: hosts.length,
    },
  };
}

const orderHosts: TopologyLearningHost[] = [
  host({
    agentId: AGENT_A,
    hostname: 'gw-01',
    ip: '10.0.0.11',
    appSystemId: 'as-order',
    appSystemName: '订单系统',
    services: [{ name: 'nginx', port: 80 }],
  }),
  host({
    agentId: AGENT_B,
    hostname: 'app-01',
    ip: '10.0.0.12',
    appSystemId: 'as-order',
    appSystemName: '订单系统',
    services: [{ name: 'java', port: 8080, process: 'java' }],
  }),
  host({
    agentId: AGENT_C,
    hostname: 'db-01',
    ip: '10.0.0.13',
    appSystemId: 'as-order',
    appSystemName: '订单系统',
    services: [{ name: 'mysql', port: 3306 }],
  }),
];

const orderEdges: TopologyLearningEdge[] = [
  link({
    fromAgentId: AGENT_A,
    fromHost: 'gw-01',
    toAgentId: AGENT_B,
    toHost: 'app-01',
    toIp: '10.0.0.12',
    toPort: 8080,
    toService: 'java',
    opened: 40,
    active: 10,
    failed: 1,
  }),
  link({
    fromAgentId: AGENT_B,
    fromHost: 'app-01',
    toAgentId: AGENT_C,
    toHost: 'db-01',
    toIp: '10.0.0.13',
    toPort: 3306,
    toService: 'mysql',
    opened: 100,
    active: 20,
    failed: 2,
  }),
];

const basePeers: TopologyExternalPeer[] = [
  peer({ ip: EXTERNAL_IP, port: 443, processes: ['payment-sdk'], opened: 5, failed: 0 }),
];

const baseInput = makeInput({ hosts: orderHosts, edges: orderEdges, externalPeers: basePeers });

function completionWith(handler: (request: CompletionRequest) => Promise<string> | string): {
  service: ModelCompletionService;
  calls: CompletionRequest[];
} {
  const calls: CompletionRequest[] = [];
  const complete = async (request: CompletionRequest): Promise<string> => {
    calls.push(request);
    return handler(request);
  };
  // 断言 mock 已满足 ModelCompletionService 的最小形状（complete）。
  return { service: { complete } as unknown as ModelCompletionService, calls };
}

const TIERS = ['ingress', 'app', 'middleware', 'data', 'external', 'infra'];
const KINDS = ['gateway', 'service', 'database', 'cache', 'mq', 'storage', 'external', 'unknown'];

function expectRenderable(draft: TopologyDraft): void {
  const ids = new Set(draft.nodes.map((node) => node.id));
  expect(draft.nodes.length).toBeGreaterThan(0);
  expect(draft.nodes.length).toBeLessThanOrEqual(120);
  expect(draft.edges.length).toBeLessThanOrEqual(240);
  for (const node of draft.nodes) {
    expect(TIERS).toContain(node.tier);
    expect(KINDS).toContain(node.kind);
    expect(node.label.length).toBeGreaterThan(0);
    expect(node.label.length).toBeLessThanOrEqual(80);
  }
  for (const edge of draft.edges) {
    expect(ids.has(edge.source)).toBe(true);
    expect(ids.has(edge.target)).toBe(true);
    expect(edge.source).not.toBe(edge.target);
    expect(Number.isInteger(edge.port)).toBe(true);
    expect(edge.port).toBeGreaterThan(0);
    expect(edge.port).toBeLessThanOrEqual(65_535);
    expect(edge.count).toBeGreaterThanOrEqual(0);
    expect(edge.confidence ?? 0).toBeGreaterThanOrEqual(0);
    expect(edge.confidence ?? 0).toBeLessThanOrEqual(1);
  }
  expect(draft.insights?.length ?? 0).toBeGreaterThan(0);
  expect(draft.insights?.length ?? 0).toBeLessThanOrEqual(8);
  expect(draft.hotPaths?.length ?? 0).toBeLessThanOrEqual(5);
  expect(draft.summary?.length ?? 0).toBeGreaterThan(0);
  expect(draft.confidence ?? 0).toBeGreaterThanOrEqual(0);
  expect(draft.confidence ?? 0).toBeLessThanOrEqual(1);
}

// ---------------------------------------------------------------------------
// 模型路径：严格 JSON + 真实数字回填 + 非法引用过滤
// ---------------------------------------------------------------------------

function modelDraftAnswer(): string {
  return `\`\`\`json\n${JSON.stringify(
    {
      summary: '窗口内 3 台主机、2 条访问关系、1 个业务系统；核心链路 gw-01 → app-01:8080（50 次）；发现 0 个风险。',
      nodes: [
        { id: ID_A, label: '接入网关', kind: 'gateway', tier: 'ingress' },
        // 模型没给 status/services：应从输入主机补齐。
        { id: ID_B, label: '应用服务', kind: 'service', tier: 'app' },
        { id: ID_C, label: 'db-01', kind: 'database', tier: 'data' },
        { id: EXTERNAL_ID, label: EXTERNAL_IP, kind: 'external', tier: 'external' },
        // 编造的节点：不在输入 id 集合内，必须被过滤。
        { id: 'h:deadbeef', label: '幽灵主机', kind: 'service', tier: 'app' },
      ],
      edges: [
        // 模型乱填 count/opened/failed：应被输入真实数字覆盖（opened=40, failed=1, count=max(40,10,1)=40）。
        { source: ID_A, target: ID_B, port: 8080, count: 999, opened: 999, failed: 0, protocol: 'tcp' },
        // 匹配输入边：opened=100, failed=2, count=max(100,20,1)=100。
        { source: ID_B, target: ID_C, port: 3306, count: 1, opened: 1, failed: 0 },
        // 未匹配输入边：confidence 降至 ≤ 0.5。
        { source: ID_A, target: ID_C, port: 3306, count: 5, opened: 5, failed: 0 },
        // 引用编造节点：过滤。
        { source: ID_A, target: 'h:deadbeef', port: 3306, count: 1, opened: 1, failed: 0 },
        // 自环：过滤。
        { source: ID_B, target: ID_B, port: 3306, count: 1, opened: 1, failed: 0 },
      ],
      insights: [
        {
          id: 'i-1',
          title: '应用访问数据库存在失败',
          detail: 'app-01 → db-01:3306 失败 2/100（2%），建议观察重试与连接池。',
          severity: 'warning',
          nodeIds: [ID_B, ID_C, 'h:ghost'],
          edgeIds: ['e:h:bbbbbbbb->h:cccccccc:3306', 'bogus-edge-id'],
        },
        { id: 'i-2', title: '非法严重度', detail: 'severity 不在白名单内', severity: 'catastrophic' },
        { id: 'i-3', title: '重复 id 1', detail: '重复 id 应自动去重', severity: 'info' },
        { id: 'i-3', title: '重复 id 2', detail: '重复 id 应自动加后缀', severity: 'info' },
      ],
      hotPaths: [
        {
          label: 'gw-01 → app-01 → db-01',
          nodeIds: [ID_A, ID_B, ID_C],
          edgeIds: ['e:h:aaaaaaaa->h:bbbbbbbb:8080', 'e:h:bbbbbbbb->h:cccccccc:3306'],
          connections: 140,
        },
        { label: '非法路径', nodeIds: [ID_A, 'h:ghost'], edgeIds: [], connections: 5 },
      ],
      risks: [
        {
          id: 'r-1',
          title: '数据库访问失败',
          detail: 'app-01 → db-01:3306 失败 2 次',
          severity: 'warning',
          nodeIds: [ID_B, ID_C],
          edgeIds: ['e:h:bbbbbbbb->h:cccccccc:3306'],
        },
      ],
      confidence: 0.88,
    },
    null,
    2,
  )}\n\`\`\``;
}

describe('TopologyAnalyzer model path', () => {
  it('parses fenced JSON, backfills real numbers, filters invalid references', async () => {
    const { service, calls } = completionWith(async () => modelDraftAnswer());
    const analyzer = new TopologyAnalyzer(service);
    const result = await analyzer.analyze('tenant-1', baseInput, {
      modelLabel: 'openai-compatible-mock',
      maxTokens: 2048,
    });

    // 请求形状：一次调用、model 名、prompt 内嵌输入 JSON。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tenantId).toBe('tenant-1');
    expect(calls[0]?.maxTokens).toBe(2048);
    expect(calls[0]?.system).toContain('SRE');
    expect(calls[0]?.prompt).toContain(`"from":"${ID_A}"`);
    expect(calls[0]?.prompt).toContain(`"to":"${ID_B}"`);

    const { draft, analysis } = result;
    expect(analysis.fallback).toBe(false);
    expect(analysis.model).toBe('openai-compatible-mock');
    expect(analysis.promptVersion).toBe(TOPOLOGY_PROMPT_VERSION);
    expect(analysis.warning).toBeUndefined();
    expect(analysis.confidence).toBeGreaterThanOrEqual(0.75);
    expect(analysis.confidence).toBeLessThanOrEqual(0.9);
    expect(analysis.durationMs).toBeGreaterThanOrEqual(0);

    expectRenderable(draft);

    // 编造节点被过滤，合法节点保留 4 个。
    const nodeIds = draft.nodes.map((node) => node.id).sort();
    expect(nodeIds).toEqual([ID_A, ID_B, ID_C, EXTERNAL_ID].sort());
    expect(nodeIds).not.toContain('h:deadbeef');

    // 模型没给的 status/services 从输入主机补齐；label/appSystemId 取模型/输入。
    const appNode = draft.nodes.find((node) => node.id === ID_B);
    expect(appNode).toMatchObject({
      label: '应用服务',
      kind: 'service',
      tier: 'app',
      status: 'online',
      appSystemId: 'as-order',
      appSystemName: '订单系统',
    });
    expect(appNode?.services).toEqual([{ name: 'java', port: 8080, process: 'java' }]);
    expect(draft.nodes.find((node) => node.id === ID_A)).toMatchObject({
      label: '接入网关',
      tier: 'ingress',
      services: [{ name: 'nginx', port: 80 }],
    });
    expect(draft.nodes.find((node) => node.id === EXTERNAL_ID)).toMatchObject({
      kind: 'external',
      tier: 'external',
      inferred: true,
    });

    // 真实数字回填 + confidence 封顶。
    const edgeAb = draft.edges.find((edge) => edge.source === ID_A && edge.target === ID_B);
    expect(edgeAb).toMatchObject({ port: 8080, count: 40, opened: 40, failed: 1 });
    expect(edgeAb?.confidence ?? 0).toBeLessThanOrEqual(0.9);
    const edgeBc = draft.edges.find((edge) => edge.source === ID_B && edge.target === ID_C);
    expect(edgeBc).toMatchObject({ port: 3306, count: 100, opened: 100, failed: 2 });
    // 未匹配模型边：置信度降至 0.5。
    const edgeAc = draft.edges.find((edge) => edge.source === ID_A && edge.target === ID_C);
    expect(edgeAc).toBeDefined();
    expect(edgeAc?.confidence).toBeLessThanOrEqual(0.5);
    // 非法引用/自环边被过滤。
    expect(draft.edges.some((edge) => edge.target === 'h:deadbeef')).toBe(false);
    expect(draft.edges).toHaveLength(3);

    // 洞察：非法 severity 归一为 info，非法引用被过滤，重复 id 去重。
    expect(draft.insights).toHaveLength(4);
    const failureInsight = draft.insights?.find((insight) => insight.id === 'i-1');
    expect(failureInsight?.severity).toBe('warning');
    expect(failureInsight?.nodeIds).toEqual([ID_B, ID_C]);
    expect(failureInsight?.edgeIds).toEqual(['e:h:bbbbbbbb->h:cccccccc:3306']);
    expect(draft.insights?.find((insight) => insight.id === 'i-2')?.severity).toBe('info');
    const insightIds = draft.insights?.map((insight) => insight.id) ?? [];
    expect(new Set(insightIds).size).toBe(insightIds.length);

    // hotPaths：非法路径被剔除，合法路径保留且 edgeIds 符合落库口径。
    expect(draft.hotPaths).toHaveLength(1);
    expect(draft.hotPaths?.[0]).toMatchObject({
      label: 'gw-01 → app-01 → db-01',
      nodeIds: [ID_A, ID_B, ID_C],
      edgeIds: ['e:h:aaaaaaaa->h:bbbbbbbb:8080', 'e:h:bbbbbbbb->h:cccccccc:3306'],
      connections: 140,
    });
    expect(analysis.hotPaths).toEqual(draft.hotPaths);
    expect(draft.risks).toHaveLength(1);
    expect(analysis.risks).toEqual(draft.risks);

    // systems 由输入的 appSystemId 原值派生；外部节点归入「未归属」。
    expect(draft.systems?.find((system) => system.id === 'as-order')).toMatchObject({
      id: 'as-order',
      name: '订单系统',
      nodeIds: [ID_A, ID_B, ID_C],
    });
    expect(draft.systems?.find((system) => system.id === '__unassigned__')).toMatchObject({
      name: '未归属',
      nodeIds: [EXTERNAL_ID],
    });
    expect(draft.summary).toContain('3 台主机');
  });

  it('uses the default llm label without a user-facing warning when modelLabel is not provided', async () => {
    const { service } = completionWith(async () =>
      JSON.stringify({ summary: 'ok', nodes: [{ id: ID_A, label: 'gw', kind: 'gateway', tier: 'ingress' }], edges: [] }),
    );
    const result = await new TopologyAnalyzer(service).analyze('tenant-1', baseInput);
    expect(result.analysis.fallback).toBe(false);
    expect(result.analysis.model).toBe(DEFAULT_MODEL_LABEL);
    // 模型路径不向页面暴露实现细节：没有 warning，只有兜底才给「模型不可用」文案。
    expect(result.analysis.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 模型失败 → 确定性兜底
// ---------------------------------------------------------------------------

const failureScenarios: Array<{ name: string; handler: () => Promise<string> | string }> = [
  {
    name: 'model_not_configured',
    handler: () => {
      throw new Error('model_not_configured');
    },
  },
  { name: 'invalid JSON', handler: () => '抱歉，我暂时无法分析这个拓扑。' },
  { name: 'empty response', handler: () => '   ' },
  { name: 'empty nodes', handler: () => JSON.stringify({ summary: 'x', nodes: [], edges: [] }) },
  {
    name: 'all nodes fabricated',
    handler: () =>
      JSON.stringify({
        summary: 'x',
        nodes: [{ id: 'h:deadbeef', label: '幽灵', kind: 'service', tier: 'app' }],
        edges: [],
      }),
  },
];

describe('TopologyAnalyzer fallback', () => {
  for (const scenario of failureScenarios) {
    it(`uses deterministic heuristics on ${scenario.name}`, async () => {
      const { service } = completionWith(scenario.handler);
      const result = await new TopologyAnalyzer(service).analyze('tenant-1', baseInput);
      const { draft, analysis } = result;

      expect(analysis.fallback).toBe(true);
      expect(analysis.model).toBe('heuristic');
      expect(analysis.warning).toBe(TOPOLOGY_FALLBACK_WARNING);
      expect(analysis.promptVersion).toBe(TOPOLOGY_PROMPT_VERSION);
      expect(analysis.confidence).toBeGreaterThanOrEqual(0.55);
      expect(analysis.confidence).toBeLessThanOrEqual(0.65);

      expectRenderable(draft);
      expect(draft.nodes.length).toBeGreaterThan(0);
      expect(draft.edges.length).toBeGreaterThan(0);
      expect(draft.insights?.length ?? 0).toBeGreaterThan(0);
      expect(draft.hotPaths?.length ?? 0).toBeGreaterThan(0);
      expect(draft.confidence).toBe(analysis.confidence);

      // 节点分层正确。
      const byHostname = new Map(draft.nodes.map((node) => [node.hostname, node]));
      expect(byHostname.get('gw-01')?.tier).toBe('ingress');
      expect(byHostname.get('gw-01')?.kind).toBe('gateway');
      expect(byHostname.get('app-01')?.tier).toBe('app');
      expect(byHostname.get('db-01')?.tier).toBe('data');
      expect(byHostname.get('db-01')?.kind).toBe('database');
      const external = draft.nodes.find((node) => node.id === EXTERNAL_ID);
      expect(external).toMatchObject({ tier: 'external', kind: 'external', inferred: true, hostname: EXTERNAL_IP });

      // summary 使用真实数字。
      expect(draft.summary).toContain('3 台主机');
      expect(draft.summary).toContain(`${draft.edges.length} 条访问关系`);
      expect(draft.summary).toContain('1 个业务系统');
      expect(draft.summary).toContain(`发现 ${draft.risks?.length ?? 0} 个风险`);
    });
  }

  it('is deterministic across repeated heuristic runs', () => {
    const first = buildHeuristicDraft(baseInput);
    const second = buildHeuristicDraft(baseInput);
    expect(second).toEqual(first);
  });

  it('returns a renderable empty-state draft for empty input instead of throwing', async () => {
    const { service } = completionWith(() => {
      throw new Error('model_not_configured');
    });
    const result = await new TopologyAnalyzer(service).analyze('tenant-1', makeInput({ hosts: [] }));
    expect(result.analysis.fallback).toBe(true);
    expect(result.analysis.model).toBe('heuristic');
    expect(result.draft.nodes).toEqual([]);
    expect(result.draft.edges).toEqual([]);
    expect(result.draft.insights?.length ?? 0).toBeGreaterThan(0);
    expect(result.draft.summary).toContain('0 台主机');
    expect(result.draft.confidence ?? 0).toBeGreaterThanOrEqual(0.55);
  });
});

// ---------------------------------------------------------------------------
// 启发式分层 / 分类
// ---------------------------------------------------------------------------

describe('heuristic classification', () => {
  it('classifies nginx/redis/mysql/app/external/infra deterministically', () => {
    const hosts: TopologyLearningHost[] = [
      host({
        agentId: 'gw000001-0000-4000-8000-000000000001',
        hostname: 'gw-01',
        ip: '10.0.0.11',
        appSystemId: 'as-order',
        appSystemName: '订单系统',
        services: [{ name: 'nginx', port: 80 }],
      }),
      host({
        agentId: 'app00002-0000-4000-8000-000000000002',
        hostname: 'app-01',
        ip: '10.0.0.12',
        appSystemId: 'as-order',
        appSystemName: '订单系统',
        services: [{ name: 'java', port: 8080, process: 'java' }],
      }),
      host({
        agentId: 'red00003-0000-4000-8000-000000000003',
        hostname: 'redis-01',
        ip: '10.0.0.13',
        appSystemId: 'as-order',
        appSystemName: '订单系统',
        services: [{ name: 'redis', port: 6379 }],
      }),
      host({
        agentId: 'db000004-0000-4000-8000-000000000004',
        hostname: 'mysql-01',
        ip: '10.0.0.14',
        appSystemId: 'as-order',
        appSystemName: '订单系统',
        services: [{ name: 'mysql', port: 3306 }],
      }),
      host({
        agentId: 'idle0005-0000-4000-8000-000000000005',
        hostname: 'idle-01',
        ip: '10.0.0.15',
      }),
    ];
    const appAgent = 'app00002-0000-4000-8000-000000000002';
    const edges: TopologyLearningEdge[] = [
      link({
        fromAgentId: appAgent,
        fromHost: 'app-01',
        toAgentId: 'red00003-0000-4000-8000-000000000003',
        toHost: 'redis-01',
        toIp: '10.0.0.13',
        toPort: 6379,
        toService: 'redis',
        opened: 20,
        active: 4,
      }),
      link({
        fromAgentId: appAgent,
        fromHost: 'app-01',
        toAgentId: 'db000004-0000-4000-8000-000000000004',
        toHost: 'mysql-01',
        toIp: '10.0.0.14',
        toPort: 3306,
        toService: 'mysql',
        opened: 30,
        active: 6,
      }),
    ];
    const input = makeInput({
      hosts,
      edges,
      externalPeers: [peer({ ip: EXTERNAL_IP, port: 8443, processes: ['vendor-agent'], opened: 3 })],
    });
    const draft = buildHeuristicDraft(input);
    const byHostname = new Map(draft.nodes.map((node) => [node.hostname, node]));

    expect(byHostname.get('gw-01')).toMatchObject({ tier: 'ingress', kind: 'gateway' });
    expect(byHostname.get('app-01')).toMatchObject({ tier: 'app', kind: 'service' });
    expect(byHostname.get('redis-01')).toMatchObject({ tier: 'middleware', kind: 'cache' });
    expect(byHostname.get('mysql-01')).toMatchObject({ tier: 'data', kind: 'database' });
    expect(byHostname.get('idle-01')).toMatchObject({ tier: 'infra', kind: 'unknown' });

    const externalNode = draft.nodes.find((node) => node.id === EXTERNAL_ID);
    expect(externalNode).toMatchObject({
      tier: 'external',
      kind: 'external',
      hostname: EXTERNAL_IP,
      ip: EXTERNAL_IP,
      inferred: true,
    });
    expect(externalNode?.services?.map((service) => service.port)).toContain(8443);

    // 端口 443 + 被访问 → ingress。
    const proxy = host({ agentId: 'proxy-01', hostname: 'proxy-01', services: [{ name: 'custom-api', port: 443 }] });
    expect(classifyManagedHost(proxy, { inbound: 0, total: 0 })).toEqual({ tier: 'app', kind: 'service' });
    expect(classifyManagedHost(proxy, { inbound: 5, total: 5 })).toEqual({ tier: 'ingress', kind: 'gateway' });

    // 直接分类：nginx/redis/mysql。
    expect(
      classifyManagedHost(host({ agentId: 'a', hostname: 'a', services: [{ name: 'nginx', port: 80 }] }), {
        inbound: 0,
        total: 1,
      }),
    ).toEqual({ tier: 'ingress', kind: 'gateway' });
    expect(
      classifyManagedHost(host({ agentId: 'b', hostname: 'b', services: [{ name: 'redis-server', port: 6379 }] }), {
        inbound: 1,
        total: 1,
      }),
    ).toEqual({ tier: 'middleware', kind: 'cache' });
    expect(
      classifyManagedHost(host({ agentId: 'c', hostname: 'c', services: [{ name: 'mysqld', port: 3306 }] }), {
        inbound: 1,
        total: 1,
      }),
    ).toEqual({ tier: 'data', kind: 'database' });

    expectRenderable(draft);
  });
});

// ---------------------------------------------------------------------------
// 风险 / 热点路径 / 统计
// ---------------------------------------------------------------------------

describe('heuristic insights and hot paths', () => {
  it('reports failure-rate and single-point risks with real numbers', () => {
    const hosts: TopologyLearningHost[] = [
      host({
        agentId: AGENT_A,
        hostname: 'gw-01',
        ip: '10.0.0.11',
        appSystemId: 'as-order',
        appSystemName: '订单系统',
        services: [{ name: 'nginx', port: 80 }],
      }),
      host({
        agentId: AGENT_B,
        hostname: 'app-01',
        ip: '10.0.0.12',
        appSystemId: 'as-order',
        appSystemName: '订单系统',
        services: [{ name: 'java', port: 8080, process: 'java' }],
      }),
      host({
        agentId: AGENT_C,
        hostname: 'db-01',
        ip: '10.0.0.13',
        appSystemId: 'as-order',
        appSystemName: '订单系统',
        services: [{ name: 'mysql', port: 3306 }],
      }),
    ];
    const edges: TopologyLearningEdge[] = [
      link({
        fromAgentId: AGENT_A,
        fromHost: 'gw-01',
        toAgentId: AGENT_B,
        toHost: 'app-01',
        toPort: 8080,
        toService: 'java',
        opened: 50,
        active: 10,
      }),
      link({
        fromAgentId: AGENT_B,
        fromHost: 'app-01',
        toAgentId: AGENT_C,
        toHost: 'db-01',
        toPort: 3306,
        toService: 'mysql',
        opened: 100,
        active: 20,
        failed: 30,
      }),
    ];
    const draft = buildHeuristicDraft(makeInput({ hosts, edges }));

    // 失败边 → warning/critical。
    const failureInsight = draft.insights?.find((insight) => insight.id.startsWith('edge-failure-'));
    expect(failureInsight?.severity).toBe('warning');
    expect(failureInsight?.detail).toContain('30');
    expect(failureInsight?.detail).toContain('30.0%');
    expect(draft.risks?.some((risk) => risk.severity !== 'info')).toBe(true);

    // 单点：订单系统只有 db-01 一个数据节点。
    const singlePoint = draft.insights?.find((insight) => insight.title.includes('单点依赖'));
    expect(singlePoint?.severity).toBe('warning');
    expect(singlePoint?.detail).toContain('db-01');
    expect(singlePoint?.nodeIds).toEqual([ID_C]);

    // 高频链路 Top3（此处 2 条）。
    expect(draft.insights?.filter((insight) => insight.id.startsWith('hot-link-')).length).toBe(2);

    // summary 真实数字 + 风险数一致。
    expect(draft.summary).toContain('3 台主机');
    expect(draft.summary).toContain('2 条访问关系');
    expect(draft.summary).toContain('1 个业务系统');
    expect(draft.summary).toContain(`发现 ${draft.risks?.length ?? 0} 个风险`);
    expect(draft.summary).toContain('核心链路');
  });

  it('computes the top hot path from ingress along the highest-volume edges', () => {
    const draft = buildHeuristicDraft(baseInput);
    expect(draft.hotPaths?.[0]).toMatchObject({
      nodeIds: [ID_A, ID_B, ID_C],
      edgeIds: [
        `e:${ID_A}->${ID_B}:8080`,
        `e:${ID_B}->${ID_C}:3306`,
      ],
      connections: 140, // A→B count=max(40,10,1)=40，B→C count=max(100,20,1)=100
    });
    expect(draft.hotPaths?.[0]?.label).toContain('gw-01');
    expect(draft.hotPaths?.[0]?.label).toContain('db-01');
    const edgeIds = new Set(draft.edges.map((edge) => topologyEdgeId(edge)));
    for (const edgeId of draft.hotPaths?.[0]?.edgeIds ?? []) {
      expect(edgeIds.has(edgeId)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt：user message 内嵌紧凑 TopologyLearningInput JSON（字段名契约）
// ---------------------------------------------------------------------------

describe('topology prompt payload', () => {
  it('embeds a compact TopologyLearningInput JSON with stable ids and expected field names', () => {
    const prompt = buildTopologyPrompt(baseInput);
    const payload = prompt.payload;

    // 顶层字段名。
    expect(Object.keys(payload).sort()).toEqual(
      ['edges', 'externalPeers', 'hosts', 'scope', 'stats', 'window'].sort(),
    );
    expect(payload.scope).toEqual({ kind: 'tenant', appSystemId: null });
    expect(payload.window).toEqual(baseInput.window);
    expect(payload.stats).toEqual(baseInput.stats);

    // hosts：id/hostname/ip/appSystemName/services 字段名（hosts 按连接量排序，按 id 查找）。
    expect(payload.hosts).toHaveLength(3);
    const hostRecord = payload.hosts.find((item) => item.id === ID_A) as unknown as Record<string, unknown>;
    for (const field of ['id', 'hostname', 'ip', 'status', 'appSystemId', 'appSystemName', 'services']) {
      expect(Object.keys(hostRecord)).toContain(field);
    }
    expect(hostRecord.id).toBe(ID_A);
    expect(hostRecord.hostname).toBe('gw-01');
    expect(hostRecord.ip).toBe('10.0.0.11');
    expect(hostRecord.appSystemName).toBe('订单系统');
    expect(hostRecord.services).toEqual([{ name: 'nginx', port: 80 }]);

    // edges：from/to/port/count/opened/failed/service 字段名 + 节点 id 已解析。
    const edgeRecord = payload.edges.find((item) => item.from === ID_A && item.to === ID_B) as unknown as Record<
      string,
      unknown
    >;
    for (const field of ['from', 'to', 'port', 'count', 'opened', 'active', 'failed', 'protocol', 'direction', 'service']) {
      expect(Object.keys(edgeRecord)).toContain(field);
    }
    expect(edgeRecord.from).toBe(ID_A);
    expect(edgeRecord.to).toBe(ID_B);
    expect(edgeRecord.port).toBe(8080);
    expect(edgeRecord.count).toBe(40);
    expect(edgeRecord.opened).toBe(40);
    expect(edgeRecord.service).toBe('java');
    for (const edge of payload.edges) {
      expect(edge.from.startsWith('h:')).toBe(true);
      expect(edge.to === ID_A || edge.to === ID_B || edge.to === ID_C || edge.to.startsWith('x:')).toBe(true);
    }

    // externalPeers：id/ip/ports/processes/opened/failed 字段名。
    expect(payload.externalPeers).toHaveLength(1);
    const peerRecord = payload.externalPeers[0] as unknown as Record<string, unknown>;
    for (const field of ['id', 'ip', 'ports', 'processes', 'opened', 'failed']) {
      expect(Object.keys(peerRecord)).toContain(field);
    }
    expect(peerRecord.id).toBe(EXTERNAL_ID);
    expect(peerRecord.ip).toBe(EXTERNAL_IP);
    expect(peerRecord.ports).toEqual([443]);

    // user message 原样嵌入 JSON，且 mock server 能直接解析出节点 id。
    const embedded = prompt.prompt.slice(prompt.prompt.indexOf('{'), prompt.prompt.lastIndexOf('}') + 1);
    const parsed = JSON.parse(embedded) as {
      hosts: Array<{ id: string }>;
      edges: Array<{ from: string; to: string }>;
      externalPeers: Array<{ id: string }>;
    };
    expect(parsed.hosts.map((item) => item.id).sort()).toEqual([ID_A, ID_B, ID_C].sort());
    expect(parsed.edges.find((item) => item.from === ID_A && item.to === ID_B)).toMatchObject({
      from: ID_A,
      to: ID_B,
    });
    expect(parsed.externalPeers[0]?.id).toBe(EXTERNAL_ID);
    expect(prompt.system).toContain('JSON schema');
    expect(prompt.system).toContain('SRE');
  });

  it('caps hosts ≤ 80, edges ≤ 120 and external peers ≤ 30 while keeping the busiest edge', () => {
    const hosts: TopologyLearningHost[] = [];
    for (let index = 0; index < 150; index += 1) {
      const suffix = String(index).padStart(3, '0');
      hosts.push(
        host({
          agentId: `host${suffix}-0000-4000-8000-000000000000`,
          hostname: `host-${suffix}`,
          ip: `10.1.${Math.floor(index / 250)}.${(index % 250) + 1}`,
          appSystemId: index % 2 === 0 ? 'as-a' : 'as-b',
          appSystemName: index % 2 === 0 ? '系统 A' : '系统 B',
          services: [{ name: 'java', port: 8080 }],
        }),
      );
    }
    const edges: TopologyLearningEdge[] = [];
    for (let index = 1; index < 150; index += 1) {
      const from = hosts[index - 1];
      const to = hosts[index];
      if (!from || !to) continue;
      edges.push(
        link({
          fromAgentId: from.agentId,
          fromHost: from.hostname,
          toAgentId: to.agentId,
          toHost: to.hostname,
          toIp: to.ip,
          toPort: 8080,
          toService: 'java',
          opened: index === 1 ? 10_000 : index,
          active: 2,
          failed: index % 5,
        }),
      );
    }
    const externalPeers: TopologyExternalPeer[] = [];
    for (let index = 0; index < 35; index += 1) {
      externalPeers.push(
        peer({ ip: `198.51.100.${index + 1}`, port: 443, opened: 100 - index, failed: index }),
      );
    }
    const input = makeInput({ hosts, edges, externalPeers });
    const { payload } = buildTopologyPrompt(input);

    expect(payload.hosts.length).toBeLessThanOrEqual(80);
    expect(payload.edges.length).toBeLessThanOrEqual(120);
    expect(payload.externalPeers.length).toBeLessThanOrEqual(30);
    expect(payload.hosts.length).toBe(80);
    expect(payload.edges.length).toBe(120);
    expect(payload.externalPeers.length).toBe(30);
    // 最繁忙的边（opened=10000）必须保留且排在最前。
    expect(payload.edges[0]?.opened).toBe(10_000);
    for (const item of payload.hosts) expect(item.id).toMatch(/^h:[a-z0-9_-]+$/i);
    for (const item of payload.externalPeers) expect(item.id).toMatch(/^x:/);
  });
});

// ---------------------------------------------------------------------------
// 非法模型数值夹取
// ---------------------------------------------------------------------------

describe('model output clamping', () => {
  it('coerces invalid tier/kind/severity/numbers and drops invalid ports', async () => {
    const { service } = completionWith(async () =>
      JSON.stringify({
        summary: '夹取测试',
        nodes: [
          {
            id: ID_A,
            label: 'x'.repeat(200),
            kind: 'wormhole',
            tier: 'banana',
            status: 'sleeping',
            services: [
              { name: 'nginx', port: 0 },
              { name: 'nginx', port: 80 },
            ],
          },
          { id: ID_B, label: 'app-01', kind: 'service', tier: 'app' },
        ],
        edges: [
          // 非法端口 → 丢弃。
          { source: ID_A, target: ID_B, port: 0, count: -5, opened: -1, failed: -2, confidence: 7 },
          // 合法端口 → 回填真实 opened/failed，confidence 夹取到 1 后封顶 0.9。
          { source: ID_A, target: ID_B, port: 8080, count: -5, opened: -1, failed: -2, confidence: 7 },
        ],
        insights: [{ title: '非法严重度', detail: '应归一为 info', severity: 'catastrophic' }],
        hotPaths: [],
        confidence: 7,
      }),
    );
    const result = await new TopologyAnalyzer(service).analyze('tenant-1', baseInput);
    const { draft, analysis } = result;

    expect(analysis.fallback).toBe(false);
    expectRenderable(draft);
    const nodeA = draft.nodes.find((node) => node.id === ID_A);
    expect(nodeA?.tier).toBe('ingress');
    expect(nodeA?.kind).toBe('gateway');
    expect(nodeA?.status).toBe('online');
    expect(nodeA?.label.length).toBeLessThanOrEqual(80);
    expect(nodeA?.services).toEqual([{ name: 'nginx', port: 80 }]);
    expect(draft.edges).toHaveLength(1);
    expect(draft.edges[0]).toMatchObject({ port: 8080, count: 40, opened: 40, failed: 1 });
    expect(draft.edges[0]?.confidence).toBeLessThanOrEqual(0.9);
    expect(draft.insights?.[0]?.severity).toBe('info');
    expect(analysis.confidence).toBeGreaterThanOrEqual(0.75);
    expect(analysis.confidence).toBeLessThanOrEqual(0.9);
  });
});
