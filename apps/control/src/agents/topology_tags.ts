import type { Pool } from 'pg';
import type {
  TopologyEdgeTag,
  TopologyEdgeTagInput,
  TopologyGraph,
  TopologyNode,
} from '@opsagent/contracts';

/** 访问关系标签：跨拓扑版本按 relationKey 复用，用于人工标注与趋势建议。 */
export const EDGE_TAG_LABEL_MAX = 40;
export const EDGE_TAG_CATEGORY_MAX = 40;
export const EDGE_TAG_COLOR_MAX = 20;
export const EDGE_TAG_NOTE_MAX = 500;
export const EDGE_TAG_RELATION_KEY_MAX = 400;

/**
 * 访问关系标识：`源主机名|目标主机名或IP|目标端口`。
 * 主机名优先于 IP，保证跨版本（节点短 id 变化）稳定；非法端口按 0 处理。
 */
export function topologyRelationKey(source: string, target: string, port: number): string {
  const sourceName = (source.trim() || 'unknown').slice(0, 160);
  const targetName = (target.trim() || 'unknown').slice(0, 160);
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  return `${sourceName}|${targetName}|${safePort}`;
}

/** 节点在关系标识里使用的名称：hostname → ip → label → id。 */
export function topologyNodeRelationName(node: TopologyNode): string {
  return node.hostname?.trim() || node.ip?.trim() || node.label?.trim() || node.id;
}

/**
 * 旧图兼容：按 nodes 的 id→hostname/ip/label 映射补齐缺失的 relationKey。
 * 新图在 buildGraphPayload 已写入，这里只处理历史数据。
 */
export function backfillGraphRelationKeys(graph: TopologyGraph): TopologyGraph {
  if (!Array.isArray(graph.edges) || graph.edges.length === 0) return graph;
  const names = new Map<string, string>();
  for (const node of graph.nodes ?? []) names.set(node.id, topologyNodeRelationName(node));
  let changed = false;
  const edges = graph.edges.map((edge) => {
    if (typeof edge.relationKey === 'string' && edge.relationKey.trim()) return edge;
    changed = true;
    const source = names.get(edge.source) ?? edge.source;
    const target = names.get(edge.target) ?? edge.target;
    return { ...edge, relationKey: topologyRelationKey(source, target, edge.port) };
  });
  return changed ? { ...graph, edges } : graph;
}

/** 把标签按 relationKey 挂到图的边上（不匹配的边保持原样）。 */
export function attachEdgeTags(graph: TopologyGraph, tags: readonly TopologyEdgeTag[]): TopologyGraph {
  if (tags.length === 0 || !Array.isArray(graph.edges) || graph.edges.length === 0) return graph;
  const byKey = new Map<string, TopologyEdgeTag[]>();
  for (const tag of tags) {
    const list = byKey.get(tag.relationKey);
    if (list) list.push(tag);
    else byKey.set(tag.relationKey, [tag]);
  }
  let changed = false;
  const edges = graph.edges.map((edge) => {
    const matched = edge.relationKey ? byKey.get(edge.relationKey) : undefined;
    if (!matched || matched.length === 0) return edge;
    changed = true;
    return { ...edge, tags: matched };
  });
  return changed ? { ...graph, edges } : graph;
}

export interface NormalizedEdgeTagInput {
  readonly relationKey: string;
  readonly label: string;
  readonly category: string;
  readonly color: string;
  readonly note: string;
  readonly source: 'user' | 'model';
}

/** 校验并截断标签输入；relationKey/label 缺失返回 null（路由 400）。 */
export function normalizeEdgeTagInput(value: unknown): NormalizedEdgeTagInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const relationKey = typeof record.relationKey === 'string' ? record.relationKey.trim() : '';
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  if (!relationKey || !label) return null;
  return {
    relationKey: relationKey.slice(0, EDGE_TAG_RELATION_KEY_MAX),
    label: label.slice(0, EDGE_TAG_LABEL_MAX),
    category: typeof record.category === 'string' ? record.category.trim().slice(0, EDGE_TAG_CATEGORY_MAX) : '',
    color: typeof record.color === 'string' ? record.color.trim().slice(0, EDGE_TAG_COLOR_MAX) : '',
    note: typeof record.note === 'string' ? record.note.trim().slice(0, EDGE_TAG_NOTE_MAX) : '',
    // 用户手工标签默认 user；采纳 AI 建议时可显式传 model。
    source: record.source === 'model' ? 'model' : 'user',
  };
}

interface EdgeTagRow {
  id: string;
  relation_key: string;
  label: string;
  category: string;
  color: string;
  note: string;
  source: string;
}

function tagFromRow(row: EdgeTagRow): TopologyEdgeTag {
  const source = row.source === 'model' || row.source === 'auto' ? row.source : 'user';
  return {
    id: row.id,
    relationKey: row.relation_key,
    label: row.label,
    ...(row.category ? { category: row.category } : {}),
    ...(row.color ? { color: row.color } : {}),
    ...(row.note ? { note: row.note } : {}),
    source,
  };
}

/** 访问关系标签读写服务（用户手工标签；同一 relationKey+label 幂等 upsert）。 */
export class TopologyEdgeTagService {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string, relationKey?: string | null): Promise<TopologyEdgeTag[]> {
    const params: unknown[] = [tenantId];
    let filter = '';
    if (relationKey) {
      filter = ' AND relation_key = $2';
      params.push(relationKey.slice(0, EDGE_TAG_RELATION_KEY_MAX));
    }
    const result = await this.pool.query<EdgeTagRow>(
      `SELECT id, relation_key, label, category, color, note, source
       FROM topology_edge_tags
       WHERE tenant_id = $1${filter}
       ORDER BY updated_at DESC, label`,
      params,
    );
    return result.rows.map(tagFromRow);
  }

  async create(
    tenantId: string,
    input: unknown,
    createdBy: string | null,
  ): Promise<TopologyEdgeTag | null> {
    const normalized = normalizeEdgeTagInput(input);
    if (!normalized) return null;
    const result = await this.pool.query<EdgeTagRow>(
      `INSERT INTO topology_edge_tags
         (tenant_id, relation_key, label, category, color, note, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, relation_key, label) DO UPDATE SET
         category = EXCLUDED.category,
         color = EXCLUDED.color,
         note = EXCLUDED.note,
         source = EXCLUDED.source,
         updated_at = now()
       RETURNING id, relation_key, label, category, color, note, source`,
      [
        tenantId,
        normalized.relationKey,
        normalized.label,
        normalized.category,
        normalized.color,
        normalized.note,
        normalized.source,
        createdBy,
      ],
    );
    const row = result.rows[0];
    return row ? tagFromRow(row) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM topology_edge_tags WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
