import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import {
  ADJUST_REPLY_MAX,
  MAX_ADJUST_OPERATIONS,
  TopologyAdjustmentService,
  sanitizeAdjustOperations,
} from './topology_adjustments.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000002';

let dbAvailable = false;
try {
  const probe = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
  await probe.query('SELECT 1');
  await probe.end();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

describe('sanitizeAdjustOperations', () => {
  it('keeps whitelisted operations and drops unknown/invalid ones', () => {
    const operations = sanitizeAdjustOperations([
      { op: 'hideNode', nodeId: 'h:web' },
      { op: 'showNode', nodeId: 'h:web' },
      { op: 'hideEdge', relationKey: 'web|db|3306' },
      { op: 'renameNode', nodeId: 'h:web', label: 'x'.repeat(500) },
      { op: 'setNodeDisplay', nodeId: 'h:web', tier: 'data', kind: 'database', product: 'MySQL' },
      { op: 'tagEdge', relationKey: 'web|db|3306', label: '核心链路', category: '数据访问' },
      { op: 'setFilter', key: 'external', value: false },
      { op: 'focusNode', nodeId: 'h:db' },
      { op: 'moveNode', nodeId: 'h:db', direction: 'right', distance: 999 },
      { op: 'resetView' },
      // 非法/未知：
      { op: 'deleteNode', nodeId: 'h:db' },
      { op: 'hideNode' },
      { op: 'setNodeDisplay', nodeId: 'h:web', tier: 'ingress' },
      { op: 'setFilter', key: 'unknown', value: true },
      { op: 'moveNode', nodeId: 'h:db', direction: 'up' },
    ]);
    expect(operations.map((operation) => operation.op)).toEqual([
      'hideNode',
      'showNode',
      'hideEdge',
      'renameNode',
      'setNodeDisplay',
      'tagEdge',
      'setFilter',
      'focusNode',
      'moveNode',
      'resetView',
    ]);
    expect(operations[3]).toMatchObject({ op: 'renameNode', label: 'x'.repeat(200) });
    expect(operations[8]).toMatchObject({ op: 'moveNode', distance: 500 });
    expect(operations[4]).toMatchObject({ op: 'setNodeDisplay', tier: 'data', kind: 'database' });
  });

  it('caps operations at 50 and ignores non-array input', () => {
    const operations = sanitizeAdjustOperations(
      Array.from({ length: MAX_ADJUST_OPERATIONS + 10 }, (_, index) => ({ op: 'hideNode', nodeId: `h:${index}` })),
    );
    expect(operations).toHaveLength(MAX_ADJUST_OPERATIONS);
    expect(sanitizeAdjustOperations('not-an-array')).toEqual([]);
  });
});

const describeDb = dbAvailable ? describe : describe.skip;

describeDb('TopologyAdjustmentService (postgres)', () => {
  let pool: Pool;
  let service: TopologyAdjustmentService;
  let graphId: string;
  let sessionId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
    await seed(pool);
    const session = await pool.query<{ id: string }>(
      `INSERT INTO topology_learning_sessions
         (tenant_id, window_seconds, status, started_at, ends_at)
       VALUES ($1, 60, 'ready', now() - interval '1 hour', now())
       RETURNING id`,
      [tenantId],
    );
    sessionId = session.rows[0]?.id ?? '';
    const graph = await pool.query<{ id: string }>(
      `INSERT INTO topology_graphs
         (tenant_id, session_id, scope_kind, mode, version, window_start, window_end, window_seconds,
          nodes, edges, systems, analysis, stats, model, prompt_version, fallback)
       VALUES ($1, $2, 'tenant', 'host', 1, now() - interval '1 hour', now(), 60,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'heuristic', 'v1', false)
       RETURNING id`,
      [tenantId, sessionId],
    );
    graphId = graph.rows[0]?.id ?? '';
    service = new TopologyAdjustmentService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates adjustments, trims operations and returns newest first', async () => {
    const first = await service.create({
      tenantId,
      userId: null,
      graphId,
      instruction: '隐藏外部依赖',
      response: {
        reply: '已隐藏外部依赖。'.repeat(1000),
        operations: [
          { op: 'setFilter', key: 'external', value: false },
          ...Array.from({ length: 60 }, (_, index) => ({ op: 'hideNode' as const, nodeId: `h:${index}` })),
        ],
        model: 'mock-model',
        fallback: false,
      },
    });
    expect(first).not.toBeNull();
    expect(first?.graphId).toBe(graphId);
    expect(first?.operations).toHaveLength(MAX_ADJUST_OPERATIONS);
    expect(first?.reply.length).toBe(ADJUST_REPLY_MAX);
    expect(first?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const second = await service.create({
      tenantId,
      userId: null,
      graphId,
      instruction: '重新显示',
      response: {
        reply: 'ok',
        operations: [{ op: 'showNode', nodeId: 'h:web' }],
        model: 'rule',
        fallback: true,
        warning: 'model_not_configured',
      },
    });
    expect(second?.warning).toBe('model_not_configured');
    const list = await service.list(tenantId, graphId);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(second?.id);
    expect(list[1]?.id).toBe(first?.id);
    expect(await service.list(tenantId, graphId, 1)).toHaveLength(1);
  });

  it('deletes a single adjustment and reports missing ids', async () => {
    const [latest] = await service.list(tenantId, graphId);
    expect(await service.delete(tenantId, graphId, latest?.id ?? '')).toBe(true);
    expect(await service.delete(tenantId, graphId, latest?.id ?? '')).toBe(false);
  });

  it('enforces tenant isolation for create/list/delete', async () => {
    const foreignCreate = await service.create({
      tenantId: otherTenantId,
      userId: null,
      graphId,
      instruction: '跨租户',
      response: { reply: 'x', operations: [], model: 'rule', fallback: true },
    });
    expect(foreignCreate).toBeNull();
    expect(await service.list(otherTenantId, graphId)).toEqual([]);
    const [remaining] = await service.list(tenantId, graphId);
    expect(await service.delete(otherTenantId, graphId, remaining?.id ?? '')).toBe(false);
    expect(await service.list(tenantId, graphId)).toHaveLength(1);
  });
});
