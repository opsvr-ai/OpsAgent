import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionRequest, ModelCompletionService } from '../models/completion.js';
import {
  EDGE_TAG_CATEGORIES,
  TopologyEdgeClassifier,
  type EdgeClassificationInput,
} from './topology_edge_classifier.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function edge(
  relationKey: string,
  overrides: Partial<EdgeClassificationInput> = {},
): EdgeClassificationInput {
  return {
    relationKey,
    sourceHost: 'app-01',
    targetHost: 'target-01',
    targetPort: 8080,
    ...overrides,
  };
}

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

/** 从 user prompt 中取出关系数组（prompt 头部/尾部不含方括号）。 */
function promptEdges(prompt: string): Array<Record<string, unknown>> {
  const start = prompt.indexOf('[');
  const end = prompt.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  return JSON.parse(prompt.slice(start, end + 1)) as Array<Record<string, unknown>>;
}

const ruleCoverageEdges: EdgeClassificationInput[] = [
  edge('app-01|ops-22:22', { targetHost: 'ops-22', targetPort: 22 }),
  edge('app-01|zabbix:10050', { targetHost: 'zabbix', targetPort: 10050 }),
  edge('app-01|zabbix:10051', { targetHost: 'zabbix', targetPort: 10051 }),
  edge('app-01|node-exporter:9100', { targetHost: 'node-exporter', targetPort: 9100 }),
  edge('app-01|prometheus:9090', { targetHost: 'prometheus', targetPort: 9090 }),
  edge('app-01|grafana:3000', { targetHost: 'grafana', targetPort: 3000 }),
  edge('app-01|db-01:3306', { targetHost: 'db-01', targetPort: 3306, targetProduct: 'MySQL', targetTier: 'data' }),
  edge('app-01|redis-01:6379', {
    targetHost: 'redis-01',
    targetPort: 6379,
    targetProduct: 'Redis',
    targetTier: 'middleware',
  }),
  edge('app-01|api.example.com:443', {
    targetHost: 'api.example.com',
    targetPort: 443,
    targetTier: 'external',
  }),
  edge('app-01|svc-01:8080', {
    targetHost: 'svc-01',
    targetPort: 8080,
    sourceService: 'order-service',
    targetProduct: 'order-service',
    targetTier: 'app',
  }),
];

// ---------------------------------------------------------------------------
// 模型成功路径
// ---------------------------------------------------------------------------

describe('TopologyEdgeClassifier model path', () => {
  it('parses fenced JSON, normalizes categories, clamps confidence, filters invalid keys and dedupes by highest confidence', async () => {
    const edges = [
      edge('app-01|db-01:3306', {
        targetHost: 'db-01',
        targetPort: 3306,
        targetProduct: 'MySQL',
        targetTier: 'data',
      }),
      edge('app-01|redis-01:6379', {
        targetHost: 'redis-01',
        targetPort: 6379,
        targetProduct: 'Redis',
        targetTier: 'middleware',
      }),
    ];
    const { service, calls } = completionWith(async () =>
      fenced({
        suggestions: [
          {
            relationKey: 'app-01|db-01:3306',
            label: 'MySQL 数据访问',
            category: 'database',
            confidence: 1.7,
            reason: '目标产品 MySQL',
          },
          {
            relationKey: 'app-01|redis-01:6379',
            label: '',
            category: 'not-a-category',
            confidence: -0.5,
          },
          // relationKey 不在输入内：必须丢弃。
          { relationKey: 'ghost|host:1', label: '幽灵', category: '其他', confidence: 0.9 },
          // 同 relationKey 重复：只保留最高置信度。
          { relationKey: 'app-01|db-01:3306', label: '低置信重复', category: '其他', confidence: 0.2 },
        ],
      }),
    );
    const result = await new TopologyEdgeClassifier(service).suggest('tenant-1', edges);

    expect(result.fallback).toBe(false);
    expect(result.model).toBe('llm');
    expect(result.warning).toBeUndefined();
    expect(result.suggestions).toHaveLength(2);

    const dbSuggestion = result.suggestions.find((item) => item.relationKey === 'app-01|db-01:3306');
    expect(dbSuggestion).toMatchObject({
      label: 'MySQL 数据访问',
      category: '数据访问', // database 别名归一化
      confidence: 1, // 1.7 夹取到 1
      reason: '目标产品 MySQL',
      source: 'model',
    });

    const redisSuggestion = result.suggestions.find((item) => item.relationKey === 'app-01|redis-01:6379');
    expect(redisSuggestion).toMatchObject({
      label: '其他', // 空 label 回退到 category
      category: '其他', // 非法 category 归一化为其他
      confidence: 0, // 负数夹取到 0
      source: 'model',
    });
    expect(redisSuggestion?.reason).toBeUndefined();
    expect(result.suggestions.some((item) => item.relationKey === 'ghost|host:1')).toBe(false);

    // 请求参数：json=true / maxTokens 2200 / timeout 60s；prompt 只含关系摘要。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tenantId).toBe('tenant-1');
    expect(calls[0]?.json).toBe(true);
    expect(calls[0]?.maxTokens).toBe(2200);
    expect(calls[0]?.timeoutMs).toBe(60_000);
    expect(calls[0]?.system).toContain('运维工具');
    expect(calls[0]?.system).toContain('中间件访问');
    const payload = promptEdges(calls[0]?.prompt ?? '');
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      relationKey: 'app-01|db-01:3306',
      sourceHost: 'app-01',
      targetHost: 'db-01',
      targetPort: 3306,
      targetProduct: 'MySQL',
      targetTier: 'data',
    });
    expect((calls[0]?.prompt.length ?? 0)).toBeLessThanOrEqual(12_000);
  });
});

// ---------------------------------------------------------------------------
// 失败 → 确定性规则兜底
// ---------------------------------------------------------------------------

describe('TopologyEdgeClassifier fallback', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const scenarios: Array<{
    name: string;
    handler: () => Promise<string> | string;
    contains: string;
  }> = [
    {
      name: 'model throws',
      handler: () => {
        throw new Error('model_not_configured');
      },
      contains: 'model_not_configured',
    },
    { name: 'invalid JSON', handler: () => '抱歉，无法分类', contains: 'model_json_invalid' },
    { name: 'empty response', handler: () => '   ', contains: 'model_empty_response' },
    {
      name: 'empty suggestions',
      handler: () => JSON.stringify({ suggestions: [] }),
      contains: 'model_empty_suggestions',
    },
  ];

  for (const scenario of scenarios) {
    it(`falls back to deterministic rules on ${scenario.name}`, async () => {
      const { service } = completionWith(scenario.handler);
      const result = await new TopologyEdgeClassifier(service).suggest('tenant-1', ruleCoverageEdges);

      expect(result.fallback).toBe(true);
      expect(result.model).toBe('heuristic');
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain(scenario.contains);
      expect((result.warning ?? '').length).toBeLessThanOrEqual(200);
      expect(result.suggestions).toHaveLength(ruleCoverageEdges.length);
      expect(result.suggestions.every((item) => item.source === 'rule')).toBe(true);
      for (const suggestion of result.suggestions) {
        expect(EDGE_TAG_CATEGORIES).toContain(suggestion.category);
        expect(suggestion.confidence).toBeGreaterThanOrEqual(0.45);
        expect(suggestion.confidence).toBeLessThanOrEqual(0.65);
        expect(suggestion.label.length).toBeGreaterThan(0);
      }
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[topology] edge tag classifier failed:'),
      );
    });
  }

  it('classifies ops ports / external / data / middleware / app rules correctly', async () => {
    const { service } = completionWith(() => {
      throw new Error('model_not_configured');
    });
    const result = await new TopologyEdgeClassifier(service).suggest('tenant-1', ruleCoverageEdges);
    const categoryByKey = new Map(result.suggestions.map((item) => [item.relationKey, item.category]));

    expect(categoryByKey.get('app-01|ops-22:22')).toBe('运维工具');
    expect(categoryByKey.get('app-01|zabbix:10050')).toBe('运维工具');
    expect(categoryByKey.get('app-01|zabbix:10051')).toBe('运维工具');
    expect(categoryByKey.get('app-01|node-exporter:9100')).toBe('运维工具');
    expect(categoryByKey.get('app-01|prometheus:9090')).toBe('运维工具');
    expect(categoryByKey.get('app-01|grafana:3000')).toBe('运维工具');
    expect(categoryByKey.get('app-01|db-01:3306')).toBe('数据访问');
    expect(categoryByKey.get('app-01|redis-01:6379')).toBe('中间件访问');
    expect(categoryByKey.get('app-01|api.example.com:443')).toBe('外部依赖');
    expect(categoryByKey.get('app-01|svc-01:8080')).toBe('应用调用');

    // 规则建议 label 使用类别短名，reason 说明依据。
    const dataSuggestion = result.suggestions.find((item) => item.relationKey === 'app-01|db-01:3306');
    expect(dataSuggestion).toMatchObject({ label: '数据访问', source: 'rule' });
    expect(dataSuggestion?.reason).toContain('数据库');
    const opsSuggestion = result.suggestions.find((item) => item.relationKey === 'app-01|prometheus:9090');
    expect(opsSuggestion?.reason).toContain('9090');
  });
});

// ---------------------------------------------------------------------------
// 数量上限 / 空输入
// ---------------------------------------------------------------------------

describe('TopologyEdgeClassifier batching', () => {
  it('caps input at 80 edges and only sends the first 80 in the prompt', async () => {
    const edges = Array.from({ length: 90 }, (_, index) =>
      edge(`app-${index}|db-${index}:3306`, {
        sourceHost: `app-${index}`,
        targetHost: `db-${index}`,
        targetPort: 3306,
        targetProduct: 'MySQL',
        targetTier: 'data',
      }),
    );
    const { service, calls } = completionWith(async (request) => {
      const sent = promptEdges(request.prompt);
      return JSON.stringify({
        suggestions: sent.map((item) => ({
          relationKey: item.relationKey,
          label: 'MySQL 数据访问',
          category: '数据访问',
          confidence: 0.8,
          reason: '目标 MySQL',
        })),
      });
    });
    const result = await new TopologyEdgeClassifier(service).suggest('tenant-1', edges);

    expect(calls).toHaveLength(1);
    const sent = promptEdges(calls[0]?.prompt ?? '');
    expect(sent).toHaveLength(80);
    expect(sent[0]?.relationKey).toBe('app-0|db-0:3306');
    expect(sent[79]?.relationKey).toBe('app-79|db-79:3306');
    expect((calls[0]?.prompt.length ?? 0)).toBeLessThanOrEqual(12_000);
    expect(result.fallback).toBe(false);
    expect(result.suggestions).toHaveLength(80);
    expect(result.suggestions.some((item) => item.relationKey === 'app-80|db-80:3306')).toBe(false);
  });

  it('returns an empty result without calling the model for empty input', async () => {
    const { service, calls } = completionWith(() => {
      throw new Error('should_not_be_called');
    });
    const result = await new TopologyEdgeClassifier(service).suggest('tenant-1', []);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ suggestions: [], model: 'llm', fallback: false });
  });

  it('deduplicates input relationKeys before building the prompt', async () => {
    const edges = [
      edge('same|key:8080'),
      edge('same|key:8080', { targetPort: 8081 }),
    ];
    const { service, calls } = completionWith(async (request) => {
      const sent = promptEdges(request.prompt);
      return JSON.stringify({
        suggestions: sent.map((item) => ({
          relationKey: item.relationKey,
          label: '应用调用',
          category: '应用调用',
          confidence: 0.5,
        })),
      });
    });
    const result = await new TopologyEdgeClassifier(service).suggest('tenant-1', edges);
    expect(promptEdges(calls[0]?.prompt ?? '')).toHaveLength(1);
    expect(result.suggestions).toHaveLength(1);
  });
});
