import type { Pool } from 'pg';
import type {
  TopologyAdjustment,
  TopologyAdjustmentResponse,
  TopologyAdjustOperation,
  TopologyNodeKind,
  TopologyTier,
} from '@opsagent/contracts';

/**
 * 拓扑自然语言微调历史：保存"用户指令 + 模型回复 + 视图操作"。
 * 操作只影响当前视图（隐藏/显示/改名/打标签/焦点等），不修改原始学习图。
 */

export const MAX_ADJUST_OPERATIONS = 50;
export const ADJUST_INSTRUCTION_MAX = 500;
export const ADJUST_REPLY_MAX = 4000;
export const ADJUST_MODEL_MAX = 120;
export const ADJUST_WARNING_MAX = 500;

const NODE_KINDS: readonly TopologyNodeKind[] = [
  'gateway', 'service', 'database', 'cache', 'mq', 'registry', 'storage',
  'monitoring', 'logging', 'external', 'unknown',
];
const TIERS: readonly TopologyTier[] = ['access', 'app', 'middleware', 'data', 'ops', 'external'];
const FILTER_KEYS = ['external', 'management', 'lowTraffic', 'unassigned'] as const;
const MOVE_DIRECTIONS = ['left', 'right', 'top', 'bottom'] as const;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 操作白名单校验：未知 op / 缺必填字段 / 非法枚举一律丢弃；最多保留 50 条。
 * 返回值保证可 JSON 序列化。
 */
export function sanitizeAdjustOperations(value: unknown): TopologyAdjustOperation[] {
  if (!Array.isArray(value)) return [];
  const operations: TopologyAdjustOperation[] = [];
  for (const raw of value) {
    if (operations.length >= MAX_ADJUST_OPERATIONS) break;
    const record = asObject(raw);
    if (!record) continue;
    const nodeId = text(record.nodeId, 160);
    const relationKey = text(record.relationKey, 400);
    let operation: TopologyAdjustOperation | null = null;
    switch (record.op) {
      case 'hideNode':
      case 'showNode':
      case 'focusNode':
        if (nodeId) operation = { op: record.op, nodeId };
        break;
      case 'hideEdge':
      case 'showEdge':
        if (relationKey) operation = { op: record.op, relationKey };
        break;
      case 'renameNode': {
        const label = text(record.label, 200);
        if (nodeId && label) operation = { op: 'renameNode', nodeId, label };
        break;
      }
      case 'setNodeDisplay': {
        if (!nodeId) break;
        const tier = typeof record.tier === 'string' && (TIERS as readonly string[]).includes(record.tier)
          ? record.tier as TopologyTier
          : undefined;
        const kind = typeof record.kind === 'string' && (NODE_KINDS as readonly string[]).includes(record.kind)
          ? record.kind as TopologyNodeKind
          : undefined;
        const product = text(record.product, 120);
        const role = text(record.role, 200);
        if (!tier && !kind && !product && !role) break;
        operation = {
          op: 'setNodeDisplay',
          nodeId,
          ...(tier ? { tier } : {}),
          ...(kind ? { kind } : {}),
          ...(product ? { product } : {}),
          ...(role ? { role } : {}),
        };
        break;
      }
      case 'tagEdge': {
        const label = text(record.label, 40);
        if (!relationKey || !label) break;
        operation = {
          op: 'tagEdge',
          relationKey,
          label,
          ...(text(record.category, 40) ? { category: text(record.category, 40) } : {}),
          ...(text(record.color, 20) ? { color: text(record.color, 20) } : {}),
        };
        break;
      }
      case 'setFilter': {
        const key = typeof record.key === 'string' && (FILTER_KEYS as readonly string[]).includes(record.key)
          ? record.key as typeof FILTER_KEYS[number]
          : null;
        if (key && typeof record.value === 'boolean') {
          operation = { op: 'setFilter', key, value: record.value };
        }
        break;
      }
      case 'moveNode': {
        const direction = typeof record.direction === 'string'
          && (MOVE_DIRECTIONS as readonly string[]).includes(record.direction)
          ? record.direction as typeof MOVE_DIRECTIONS[number]
          : null;
        if (!nodeId || !direction) break;
        const distance = finiteNumber(record.distance);
        operation = {
          op: 'moveNode',
          nodeId,
          direction,
          ...(distance !== null ? { distance: Math.min(Math.max(Math.round(distance), 0), 500) } : {}),
        };
        break;
      }
      case 'resetView':
        operation = { op: 'resetView' };
        break;
      default:
        break;
    }
    if (!operation) continue;
    try {
      JSON.stringify(operation);
    } catch {
      continue;
    }
    operations.push(operation);
  }
  return operations;
}

interface AdjustmentRow {
  id: string;
  tenant_id: string;
  graph_id: string;
  user_id: string | null;
  instruction: string;
  reply: string;
  operations: unknown;
  model: string;
  fallback: boolean;
  warning: string | null;
  created_at: Date;
}

function adjustmentFromRow(row: AdjustmentRow): TopologyAdjustment {
  return {
    id: row.id,
    graphId: row.graph_id,
    instruction: row.instruction,
    reply: row.reply,
    operations: sanitizeAdjustOperations(row.operations),
    model: row.model,
    fallback: row.fallback,
    ...(row.warning ? { warning: row.warning } : {}),
    createdAt: row.created_at.toISOString(),
  };
}

/** 自然语言微调历史读写服务。 */
export class TopologyAdjustmentService {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string, graphId: string, limit = 100): Promise<TopologyAdjustment[]> {
    const size = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 100;
    const result = await this.pool.query<AdjustmentRow>(
      `SELECT id, tenant_id, graph_id, user_id, instruction, reply, operations, model,
              fallback, warning, created_at
       FROM topology_view_adjustments
       WHERE tenant_id = $1 AND graph_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [tenantId, graphId, size],
    );
    return result.rows.map(adjustmentFromRow);
  }

  async create(input: {
    readonly tenantId: string;
    readonly userId: string | null;
    readonly graphId: string;
    readonly instruction: string;
    readonly response: TopologyAdjustmentResponse;
  }): Promise<TopologyAdjustment | null> {
    const graph = await this.pool.query(
      'SELECT 1 FROM topology_graphs WHERE tenant_id = $1 AND id = $2',
      [input.tenantId, input.graphId],
    );
    if ((graph.rowCount ?? 0) === 0) return null;
    const result = await this.pool.query<AdjustmentRow>(
      `INSERT INTO topology_view_adjustments
         (tenant_id, graph_id, user_id, instruction, reply, operations, model, fallback, warning)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING id, tenant_id, graph_id, user_id, instruction, reply, operations, model,
                 fallback, warning, created_at`,
      [
        input.tenantId,
        input.graphId,
        input.userId,
        text(input.instruction, ADJUST_INSTRUCTION_MAX),
        text(input.response.reply, ADJUST_REPLY_MAX),
        JSON.stringify(sanitizeAdjustOperations(input.response.operations)),
        text(input.response.model, ADJUST_MODEL_MAX) || 'rule',
        input.response.fallback === true,
        text(input.response.warning, ADJUST_WARNING_MAX) || null,
      ],
    );
    const row = result.rows[0];
    return row ? adjustmentFromRow(row) : null;
  }

  async delete(tenantId: string, graphId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM topology_view_adjustments WHERE tenant_id = $1 AND graph_id = $2 AND id = $3',
      [tenantId, graphId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
