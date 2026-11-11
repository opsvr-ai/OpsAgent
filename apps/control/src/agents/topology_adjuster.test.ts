import { describe, expect, it } from 'vitest';
import type {
  TopologyAdjustOperation,
  TopologyEdge,
  TopologyGraph,
  TopologyNode,
} from '@opsagent/contracts';
import type { CompletionRequest, ModelCompletionService } from '../models/completion.js';
import { TopologyAdjuster } from './topology_adjuster.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function node(id: string, overrides: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id,
    label: id,
    kind: 'service',
    tier: 'app',
    status: 'online',
    services: [],
    metrics: { active: 0, opened: 0, closed: 0, failed: 0, inbound: 0, outbound: 0 },
    ...overrides,
  };
}

function edge(
  source: string,
  target: string,
  port: number,
  overrides: Partial<TopologyEdge> = {},
): TopologyEdge {
  return {
    id: `e:${source}->${target}:${port}`,
    source,
    target,
    protocol: 'tcp',
    port,
    count: 1,
    opened: 1,
    failed: 0,
    confidence: 0.9,
    ...overrides,
  };
}

function graph(
  nodes: TopologyNode[],
  edges: TopologyEdge[],
  overrides: Partial<TopologyGraph> = {},
): TopologyGraph {
  return {
    id: 'graph-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    scope: { kind: 'tenant' },
    mode: 'host',
    window: {
      start: '2026-11-11T00:00:00.000Z',
      end: '2026-11-11T00:05:00.000Z',
      seconds: 300,
    },
    nodes,
    edges,
    systems: [],
    analysis: {
      summary: '',
      insights: [],
      hotPaths: [],
      risks: [],
      model: 'llm',
      promptVersion: 'topology-v2',
      generatedAt: '2026-11-11T00:05:00.000Z',
      confidence: 0.8,
    },
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      hostCount: nodes.length,
      systemCount: 0,
      externalCount: 0,
      totalConnections: 0,
      failedConnections: 0,
      samples: 0,
      reportingAgents: 0,
    },
    createdAt: '2026-11-11T00:05:00.000Z',
    version: 1,
    ...overrides,
  };
}

const baseNodes: TopologyNode[] = [
  node('n-web', {
    label: 'web-01',
    hostname: 'web-host-01',
    tier: 'access',
    kind: 'gateway',
    product: 'Nginx',
    appSystemName: '订单系统',
  }),
  node('n-app', {
    label: 'app-01',
    hostname: 'app-host-01',
    tier: 'app',
    kind: 'service',
    product: 'order-service',
    appSystemName: '订单系统',
  }),
  node('n-db1', {
    label: 'db-01',
    hostname: 'db-host-01',
    tier: 'data',
    kind: 'database',
    product: 'MySQL',
    appSystemName: '订单系统',
  }),
  node('n-db2', {
    label: 'db-02',
    hostname: 'db-host-02',
    tier: 'data',
    kind: 'database',
    product: 'MySQL',
    appSystemName: '订单系统',
  }),
  node('n-redis', {
    label: 'redis-01',
    hostname: 'redis-host-01',
    tier: 'middleware',
    kind: 'cache',
    product: 'Redis',
  }),
  node('n-ext', {
    label: '203.0.113.9',
    hostname: '203.0.113.9',
    tier: 'external',
    kind: 'external',
    product: '外部依赖',
  }),
];

const baseEdges: TopologyEdge[] = [
  edge('n-web', 'n-app', 8080, { relationKey: 'web-01|app-01:8080' }),
  edge('n-app', 'n-db1', 3306, { relationKey: 'app-01|db-01:3306' }),
  edge('n-app', 'n-redis', 6379, { relationKey: 'app-01|redis-01:6379' }),
  edge('n-app', 'n-ext', 443, { relationKey: 'app-01|203.0.113.9:443', external: true }),
];

const baseGraph = graph(baseNodes, baseEdges);

function completionWith(handler: (request: CompletionRequest) => Promise<string> | string): {
  service: ModelCompletionService;
  calls: CompletionRequest[];
} {
  const calls: CompletionRequest[] = [];
  const complete = async (request: CompletionRequest): Promise<string> => {
    calls.push(request);
    return handler(request);
  };
  return { service: { complete } as unknown as ModelCompletionService, calls };
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function throwingCompletion(): { service: ModelCompletionService; calls: CompletionRequest[] } {
  return completionWith(() => {
    throw new Error('model_not_configured');
  });
}

function operationsOf(result: { operations: readonly TopologyAdjustOperation[] }): TopologyAdjustOperation[] {
  return [...result.operations];
}

// ---------------------------------------------------------------------------
// 模型路径
// ---------------------------------------------------------------------------

describe('TopologyAdjuster model path', () => {
  it('parses fenced JSON, maps label/hostname to ids and drops invalid operations', async () => {
    const { service, calls } = completionWith(async () =>
      fenced({
        reply: '已按指令调整视图。',
        operations: [
          // 用 hostname 指代节点：唯一映射到 n-app。
          { op: 'hideNode', nodeId: 'app-host-01' },
          // 用 label 指代节点：唯一映射到 n-db1。
          { op: 'hideNode', nodeId: 'db-01' },
          // 非法节点：丢弃。
          { op: 'hideNode', nodeId: 'ghost-99' },
          { op: 'tagEdge', relationKey: 'app-01|db-01:3306', label: '数据库访问' },
          // 非法 relationKey：丢弃。
          { op: 'hideEdge', relationKey: 'not-exist' },
          { op: 'setFilter', key: 'external', value: true },
          { op: 'renameNode', nodeId: 'n-web', label: '接入网关' },
        ],
      }),
    );
    const result = await new TopologyAdjuster(service).adjust('tenant-1', {
      graph: baseGraph,
      instruction: '隐藏 app-01 和 db-01，隐藏外环，给 app-01→db-01 打标签 数据库访问，把 web-01 改名接入网关',
    });

    expect(result.fallback).toBe(false);
    expect(result.model).toBe('llm');
    expect(result.reply).toBe('已按指令调整视图。');
    expect(result.warning).toBeUndefined();
    expect(result.clarification).toBeUndefined();

    expect(operationsOf(result)).toEqual([
      { op: 'hideNode', nodeId: 'n-app' },
      { op: 'hideNode', nodeId: 'n-db1' },
      { op: 'tagEdge', relationKey: 'app-01|db-01:3306', label: '数据库访问' },
      { op: 'setFilter', key: 'external', value: true },
      { op: 'renameNode', nodeId: 'n-web', label: '接入网关' },
    ]);

    // 模型调用参数与 prompt 内容。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.json).toBe(true);
    expect(calls[0]?.maxTokens).toBe(1200);
    expect(calls[0]?.timeoutMs).toBe(60_000);
    expect(calls[0]?.system).toContain('拓扑视图微调助手');
    expect(calls[0]?.system).toContain('resetView');
    expect(calls[0]?.prompt).toContain('web-01');
    expect(calls[0]?.prompt).toContain('app-01|db-01:3306');
    expect(calls[0]?.prompt).toContain('用户指令：');
    const payload = JSON.parse(
      (calls[0]?.prompt ?? '').slice(
        (calls[0]?.prompt ?? '').indexOf('{'),
        (calls[0]?.prompt ?? '').lastIndexOf('}') + 1,
      ),
    ) as { nodes: unknown[]; edges: unknown[] };
    expect(payload.nodes).toHaveLength(6);
    expect(payload.edges).toHaveLength(4);
  });

  it('returns clarification instead of an op when a label matches multiple nodes', async () => {
    const { service } = completionWith(async () =>
      JSON.stringify({
        reply: '已聚焦。',
        operations: [
          // "MySQL" 同时匹配 db-01/db-02：应丢弃并 clarification。
          { op: 'hideNode', nodeId: 'MySQL' },
          { op: 'focusNode', nodeId: 'web-host-01' },
        ],
      }),
    );
    const result = await new TopologyAdjuster(service).adjust('tenant-1', {
      graph: baseGraph,
      instruction: '隐藏 MySQL，只看 web-01',
    });
    expect(result.fallback).toBe(false);
    expect(result.operations).toEqual([{ op: 'focusNode', nodeId: 'n-web' }]);
    expect(result.clarification).toBeDefined();
    expect(result.clarification).toContain('MySQL');
  });

  it('accepts empty operations when the model asks a clarification question', async () => {
    const { service } = completionWith(async () =>
      JSON.stringify({
        reply: '',
        operations: [],
        clarification: '图里有 2 个 MySQL 节点，请指定具体节点 id。',
      }),
    );
    const result = await new TopologyAdjuster(service).adjust('tenant-1', {
      graph: baseGraph,
      instruction: '隐藏 MySQL',
    });
    expect(result.fallback).toBe(false);
    expect(result.model).toBe('llm');
    expect(result.operations).toEqual([]);
    expect(result.clarification).toContain('2 个 MySQL');
    expect(result.reply).toBe(result.clarification);
  });

  it('caps operations at 20', async () => {
    const operations = Array.from({ length: 25 }, (_, index) => ({
      op: 'moveNode',
      nodeId: 'n-web',
      direction: ['left', 'right', 'top', 'bottom'][index % 4],
      distance: index + 1,
    }));
    const { service } = completionWith(async () =>
      JSON.stringify({ reply: '移动节点。', operations }),
    );
    const result = await new TopologyAdjuster(service).adjust('tenant-1', {
      graph: baseGraph,
      instruction: '把 web-01 往左移一点',
    });
    expect(result.fallback).toBe(false);
    expect(result.operations).toHaveLength(20);
    expect(result.operations.every((op) => op.op === 'moveNode')).toBe(true);
  });

  it('falls back to rules when the model returns only invalid operations', async () => {
    const { service } = completionWith(async () =>
      JSON.stringify({
        reply: '无法处理。',
        operations: [{ op: 'hideNode', nodeId: 'ghost-99' }],
      }),
    );
    const result = await new TopologyAdjuster(service).adjust('tenant-1', {
      graph: baseGraph,
      instruction: '重置视图',
    });
    expect(result.fallback).toBe(true);
    expect(result.model).toBe('heuristic');
    expect(result.warning).toContain('rule_fallback:');
    expect(result.warning).toContain('model_empty_operations');
    expect(result.operations).toEqual([{ op: 'resetView' }]);
  });
});

// ---------------------------------------------------------------------------
// 模型失败 → 规则兜底
// ---------------------------------------------------------------------------

describe('TopologyAdjuster rule fallback', () => {
  const cases: Array<{
    instruction: string;
    expected: TopologyAdjustOperation;
    note?: string;
  }> = [
    { instruction: '隐藏外部依赖', expected: { op: 'setFilter', key: 'external', value: true } },
    { instruction: '显示外部依赖', expected: { op: 'setFilter', key: 'external', value: false } },
    { instruction: '收起所有外部依赖', expected: { op: 'setFilter', key: 'external', value: true } },
    { instruction: '隐藏 db-01', expected: { op: 'hideNode', nodeId: 'n-db1' } },
    { instruction: '显示 db-01', expected: { op: 'showNode', nodeId: 'n-db1' } },
    { instruction: '只看 app-01', expected: { op: 'focusNode', nodeId: 'n-app' } },
    { instruction: '聚焦 db-01', expected: { op: 'focusNode', nodeId: 'n-db1' } },
    { instruction: '定位 web-01', expected: { op: 'focusNode', nodeId: 'n-web' } },
    { instruction: '重置视图', expected: { op: 'resetView' } },
    {
      instruction: '把 web-01 改名为 接入网关',
      expected: { op: 'renameNode', nodeId: 'n-web', label: '接入网关' },
    },
    {
      instruction: '把 db-01 标成数据层',
      expected: { op: 'setNodeDisplay', nodeId: 'n-db1', tier: 'data' },
    },
    {
      instruction: '把 db-01 标成数据库',
      expected: { op: 'setNodeDisplay', nodeId: 'n-db1', tier: 'data', kind: 'database' },
    },
    {
      instruction: '隐藏 app-01→db-01:3306',
      expected: { op: 'hideEdge', relationKey: 'app-01|db-01:3306' },
    },
    {
      instruction: '显示 app-01→db-01:3306',
      expected: { op: 'showEdge', relationKey: 'app-01|db-01:3306' },
    },
    {
      instruction: '给 app-01→db-01:3306 打标签 数据库访问',
      expected: { op: 'tagEdge', relationKey: 'app-01|db-01:3306', label: '数据库访问' },
    },
  ];

  for (const item of cases) {
    it(`parses rule command: ${item.instruction}`, async () => {
      const { service } = throwingCompletion();
      const result = await new TopologyAdjuster(service).adjust('tenant-1', {
        graph: baseGraph,
        instruction: item.instruction,
      });
      expect(result.fallback).toBe(true);
      expect(result.model).toBe('heuristic');
      expect(result.warning).toContain('rule_fallback: model_not_configured');
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0]).toMatchObject(item.expected);
    });
  }

  it('asks for clarification when a rule matches multiple same-name nodes', async () => {
    const { service } = throwingCompletion();
    const result = await new TopologyAdjuster(service).adjust('tenant-1', {
      graph: baseGraph,
      instruction: '隐藏 MySQL',
    });
    expect(result.fallback).toBe(true);
    expect(result.operations).toEqual([]);
    expect(result.clarification).toBeDefined();
    expect(result.clarification?.toLowerCase()).toContain('mysql');
  });

  it('handles empty instruction without calling the model', async () => {
    const { service, calls } = completionWith(() => {
      throw new Error('should_not_be_called');
    });
    const result = await new TopologyAdjuster(service).adjust('tenant-1', {
      graph: baseGraph,
      instruction: '   ',
    });
    expect(calls).toHaveLength(0);
    expect(result.fallback).toBe(true);
    expect(result.warning).toBe('rule_fallback: empty_instruction');
    expect(result.operations).toEqual([]);
    expect(result.clarification).toBeDefined();
  });

  for (const scenario of [
    { name: 'model throws', handler: () => {
      throw new Error('model_not_configured');
    }, expectWarning: 'model_not_configured' },
    { name: 'invalid JSON', handler: () => '抱歉，我无法处理', expectWarning: 'model_json_invalid' },
    { name: 'empty response', handler: () => '   ', expectWarning: 'model_empty_response' },
    { name: 'empty operations', handler: () => JSON.stringify({ reply: '无操作', operations: [] }), expectWarning: 'model_empty_operations' },
  ]) {
    it(`falls back on ${scenario.name}`, async () => {
      const { service } = completionWith(scenario.handler);
      const result = await new TopologyAdjuster(service).adjust('tenant-1', {
        graph: baseGraph,
        instruction: '隐藏外部依赖',
      });
      expect(result.fallback).toBe(true);
      expect(result.model).toBe('heuristic');
      expect(result.warning).toContain('rule_fallback:');
      expect(result.warning).toContain(scenario.expectWarning);
      expect(result.operations).toEqual([{ op: 'setFilter', key: 'external', value: true }]);
    });
  }
});

// ---------------------------------------------------------------------------
// prompt 上限
// ---------------------------------------------------------------------------

describe('TopologyAdjuster prompt limits', () => {
  it('sends at most 60 nodes and 100 edges', async () => {
    const nodes: TopologyNode[] = Array.from({ length: 80 }, (_, index) =>
      node(`n-${index}`, { label: `host-${index}`, hostname: `host-${index}`, tier: 'app' }),
    );
    const edges: TopologyEdge[] = Array.from({ length: 150 }, (_, index) => {
      const source = `n-${index % 80}`;
      const target = `n-${(index + 1) % 80}`;
      const port = 10_000 + index;
      return edge(source, target, port, {
        relationKey: `host-${index % 80}|host-${(index + 1) % 80}:${port}`,
      });
    });
    const { service, calls } = completionWith(async () =>
      JSON.stringify({ reply: 'ok', operations: [{ op: 'resetView' }] }),
    );
    await new TopologyAdjuster(service).adjust('tenant-1', {
      graph: graph(nodes, edges),
      instruction: '重置视图',
    });
    const prompt = calls[0]?.prompt ?? '';
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1)) as {
      nodes: unknown[];
      edges: unknown[];
    };
    expect(payload.nodes).toHaveLength(60);
    expect(payload.edges).toHaveLength(100);
    expect(calls[0]?.maxTokens).toBe(1200);
  });
});
