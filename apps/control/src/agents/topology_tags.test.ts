import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import type { TopologyGraph, TopologyNode } from '@opsagent/contracts';
import {
  EDGE_TAG_CATEGORY_MAX,
  EDGE_TAG_LABEL_MAX,
  EDGE_TAG_NOTE_MAX,
  TopologyEdgeTagService,
  attachEdgeTags,
  backfillGraphRelationKeys,
  normalizeEdgeTagInput,
  topologyNodeRelationName,
  topologyRelationKey,
} from './topology_tags.js';
import {
  buildRuleSuggestions,
  collectEdgeClassificationInputs,
  suggestEdgeTagsFromGraph,
  type EdgeClassificationInput,
  type EdgeClassifierLike,
} from './topology_routes.js';

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

function node(overrides: Partial<TopologyNode> & Pick<TopologyNode, 'id'>): TopologyNode {
  const { id, ...rest } = overrides;
  return {
    id,
    label: rest.label ?? id,
    kind: 'service',
    tier: 'app',
    status: 'online',
    services: [],
    metrics: { active: 0, opened: 0, closed: 0, failed: 0, inbound: 0, outbound: 0 },
    ...rest,
  };
}

function graph(overrides: Partial<TopologyGraph> = {}): TopologyGraph {
  return {
    id: 'graph-1',
    tenantId,
    sessionId: 'session-1',
    scope: { kind: 'tenant', appSystemId: null },
    mode: 'host',
    window: { start: '2026-11-11T00:00:00.000Z', end: '2026-11-11T01:00:00.000Z', seconds: 3600 },
    nodes: [
      node({ id: 'h:web', label: 'web-01', hostname: 'web-01', ip: '10.0.1.11' }),
      node({ id: 'h:db', label: 'db-01', hostname: 'db-01', ip: '10.0.2.21' }),
      node({ id: 'x:ext', label: '203.0.113.9', kind: 'external', tier: 'external', ip: '203.0.113.9' }),
    ],
    edges: [
      {
        id: 'e:h:web->h:db:3306',
        source: 'h:web',
        target: 'h:db',
        protocol: 'tcp',
        port: 3306,
        count: 10,
        opened: 10,
        failed: 0,
        confidence: 0.9,
        label: 'db:3306',
      },
      {
        id: 'e:h:web->x:ext:443',
        source: 'h:web',
        target: 'x:ext',
        protocol: 'tcp',
        port: 443,
        count: 3,
        opened: 3,
        failed: 1,
        confidence: 0.7,
        label: 'ext:443',
      },
    ],
    systems: [],
    analysis: {
      summary: 'test',
      insights: [],
      hotPaths: [],
      risks: [],
      model: 'heuristic',
      promptVersion: 'v1',
      generatedAt: '2026-11-11T01:00:00.000Z',
      confidence: 0.8,
    },
    stats: {
      nodeCount: 3,
      edgeCount: 2,
      hostCount: 2,
      systemCount: 0,
      externalCount: 1,
      totalConnections: 13,
      failedConnections: 1,
      samples: 2,
      reportingAgents: 1,
    },
    createdAt: '2026-11-11T01:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('topology tags 纯函数', () => {
  it('builds stable relation keys from host names and port', () => {
    expect(topologyRelationKey('web-01', 'db-01', 3306)).toBe('web-01|db-01|3306');
    expect(topologyRelationKey('  web-01  ', ' 203.0.113.9 ', 443)).toBe('web-01|203.0.113.9|443');
    expect(topologyRelationKey('', '', 0)).toBe('unknown|unknown|0');
    expect(topologyRelationKey('web', 'db', 70000)).toBe('web|db|0');
  });

  it('resolves node relation names with hostname → ip → label fallback', () => {
    expect(topologyNodeRelationName(node({ id: 'a', hostname: 'web', ip: '10.0.0.1' }))).toBe('web');
    expect(topologyNodeRelationName(node({ id: 'b', ip: '10.0.0.2', label: 'label-b' }))).toBe('10.0.0.2');
    expect(topologyNodeRelationName(node({ id: 'c', label: 'label-c' }))).toBe('label-c');
  });

  it('backfills relation keys for old graphs without touching existing ones', () => {
    const oldGraph = graph();
    const backfilled = backfillGraphRelationKeys(oldGraph);
    expect(backfilled.edges.map((edge) => edge.relationKey)).toEqual([
      'web-01|db-01|3306',
      'web-01|203.0.113.9|443',
    ]);
    const withExisting = graph({
      edges: [{ ...graph().edges[0]!, relationKey: 'custom|key|1' }],
    });
    expect(backfillGraphRelationKeys(withExisting).edges[0]?.relationKey).toBe('custom|key|1');
  });

  it('attaches tags by relationKey to matching edges only', () => {
    const tagged = attachEdgeTags(backfillGraphRelationKeys(graph()), [
      {
        id: 'tag-1',
        relationKey: 'web-01|db-01|3306',
        label: '核心链路',
        category: '应用调用',
        source: 'user',
      },
      {
        id: 'tag-2',
        relationKey: 'other|edge|80',
        label: '无关',
        source: 'user',
      },
    ]);
    expect(tagged.edges[0]?.tags?.map((tag) => tag.label)).toEqual(['核心链路']);
    expect(tagged.edges[1]?.tags).toBeUndefined();
  });

  it('validates and truncates tag input', () => {
    expect(normalizeEdgeTagInput(null)).toBeNull();
    expect(normalizeEdgeTagInput({ relationKey: 'x|y|1', label: '' })).toBeNull();
    expect(normalizeEdgeTagInput({ label: 'missing-relation' })).toBeNull();
    const normalized = normalizeEdgeTagInput({
      relationKey: '  web-01|db-01|3306  ',
      label: 'L'.repeat(100),
      category: 'C'.repeat(100),
      color: 'COLOR'.repeat(20),
      note: 'N'.repeat(1000),
      source: 'model',
    });
    expect(normalized?.relationKey).toBe('web-01|db-01|3306');
    expect(normalized?.label.length).toBe(EDGE_TAG_LABEL_MAX);
    expect(normalized?.category.length).toBe(EDGE_TAG_CATEGORY_MAX);
    expect(normalized?.note.length).toBe(EDGE_TAG_NOTE_MAX);
    expect(normalized?.color.length).toBe(20);
    expect(normalized?.source).toBe('model');
    expect(normalizeEdgeTagInput({ relationKey: 'x|y|1', label: '业务标签' })?.source).toBe('user');
  });
});

describe('AI 标签建议纯函数', () => {
  const edgeInput = (overrides: Partial<EdgeClassificationInput>): EdgeClassificationInput => ({
    relationKey: 'web-01|db-01|3306',
    sourceHost: 'web-01',
    targetHost: 'db-01',
    targetPort: 3306,
    ...overrides,
  });

  it('collects inputs from latest graph, filters relationKeys and caps at 80', () => {
    const inputs = collectEdgeClassificationInputs(graph());
    expect(inputs.map((input) => input.relationKey)).toEqual([
      'web-01|db-01|3306',
      'web-01|203.0.113.9|443',
    ]);
    expect(inputs[0]).toMatchObject({ sourceHost: 'web-01', targetHost: 'db-01', targetPort: 3306 });
    const filtered = collectEdgeClassificationInputs(graph(), ['web-01|203.0.113.9|443']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.targetTier).toBe('external');
  });

  it('builds deterministic rule fallback suggestions by port/tier', () => {
    const response = buildRuleSuggestions([
      edgeInput({ relationKey: 'a|b|22', targetPort: 22 }),
      edgeInput({ relationKey: 'a|ext|443', targetPort: 443, targetTier: 'external' }),
      edgeInput({ relationKey: 'a|db|3306', targetPort: 3306, targetProduct: 'MySQL', targetTier: 'data' }),
      edgeInput({ relationKey: 'a|mq|6379', targetPort: 6379, targetProduct: 'Redis', targetTier: 'middleware' }),
      edgeInput({ relationKey: 'a|svc|8080', targetPort: 8080, targetTier: 'app' }),
    ], 'classifier_unavailable');
    expect(response).toMatchObject({ model: 'rule', fallback: true, warning: 'classifier_unavailable' });
    expect(response.suggestions.map((suggestion) => suggestion.category)).toEqual([
      '运维工具',
      '外部依赖',
      '数据访问',
      '中间件访问',
      '应用调用',
    ]);
    expect(response.suggestions.every((suggestion) => suggestion.source === 'rule')).toBe(true);
  });

  it('uses classifier suggestions and filters unknown relation keys', async () => {
    const classifier: EdgeClassifierLike = {
      async suggest() {
        return {
          suggestions: [
            {
              relationKey: 'web-01|db-01|3306',
              label: '核心数据链路',
              category: '数据访问',
              confidence: 0.91,
              reason: 'MySQL 访问',
              source: 'model',
            },
            {
              relationKey: 'unknown|edge|1',
              label: '不存在',
              category: '应用调用',
              confidence: 0.5,
              source: 'model',
            },
          ],
          model: 'mock-model',
          fallback: false,
        };
      },
    };
    const response = await suggestEdgeTagsFromGraph({
      tenantId,
      edges: [edgeInput({})],
      classifier,
    });
    expect(response).toMatchObject({ model: 'mock-model', fallback: false });
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0]).toMatchObject({
      relationKey: 'web-01|db-01|3306',
      label: '核心数据链路',
      category: '数据访问',
      confidence: 0.91,
      source: 'model',
    });
  });

  it('falls back to rules when classifier throws or is unavailable', async () => {
    const throwing: EdgeClassifierLike = {
      async suggest() {
        throw new Error('model_timeout');
      },
    };
    const failed = await suggestEdgeTagsFromGraph({
      tenantId,
      edges: [edgeInput({})],
      classifier: throwing,
    });
    expect(failed.fallback).toBe(true);
    expect(failed.warning).toContain('model_timeout');
    expect(failed.suggestions[0]?.source).toBe('rule');

    const unavailable = await suggestEdgeTagsFromGraph({
      tenantId,
      edges: [edgeInput({})],
    });
    expect(unavailable.fallback).toBe(true);
    expect(unavailable.warning).toContain('classifier_unavailable');
  });
});

const describeDb = dbAvailable ? describe : describe.skip;

describeDb('TopologyEdgeTagService (postgres)', () => {
  let pool: Pool;
  let service: TopologyEdgeTagService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
    await seed(pool);
    service = new TopologyEdgeTagService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('upserts by relationKey+label and updates mutable fields', async () => {
    const first = await service.create(tenantId, {
      relationKey: 'web-01|db-01|3306',
      label: '核心链路',
      category: '应用调用',
      color: '#3b82f6',
      note: '首次',
    }, null);
    expect(first).not.toBeNull();
    const second = await service.create(tenantId, {
      relationKey: 'web-01|db-01|3306',
      label: '核心链路',
      category: '数据访问',
      note: '更新',
    }, null);
    expect(second?.id).toBe(first?.id);
    expect(second).toMatchObject({ category: '数据访问', note: '更新', source: 'user' });

    const all = await service.list(tenantId);
    expect(all).toHaveLength(1);
    const filtered = await service.list(tenantId, 'web-01|db-01|3306');
    expect(filtered).toHaveLength(1);
    expect(await service.list(tenantId, 'other|edge|3306')).toEqual([]);
  });

  it('deletes a tag and reports missing ids', async () => {
    const [tag] = await service.list(tenantId);
    expect(tag).toBeDefined();
    expect(await service.delete(tenantId, tag?.id ?? '')).toBe(true);
    expect(await service.delete(tenantId, tag?.id ?? '')).toBe(false);
    expect(await service.list(tenantId)).toEqual([]);
  });
});
