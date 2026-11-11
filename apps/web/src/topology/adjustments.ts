import type {
  TopologyAdjustOperation,
  TopologyAdjustment,
  TopologyGraph,
  TopologyNode,
  TopologyTier,
} from '@opsagent/contracts';

export type ViewFilterKey = 'external' | 'management' | 'lowTraffic' | 'unassigned';

export interface ViewAdjustmentState {
  readonly hiddenNodes: ReadonlySet<string>;
  readonly hiddenEdges: ReadonlySet<string>;
  readonly renames: ReadonlyMap<string, string>;
  readonly displays: ReadonlyMap<
    string,
    { tier?: TopologyTier; kind?: TopologyNode['kind']; product?: string; role?: string }
  >;
  readonly filters: Partial<Record<ViewFilterKey, boolean>>;
  readonly offsets: ReadonlyMap<string, { x: number; y: number }>;
  readonly focusNode: string | null;
}

export const EMPTY_ADJUSTMENT_STATE: ViewAdjustmentState = {
  hiddenNodes: new Set(),
  hiddenEdges: new Set(),
  renames: new Map(),
  displays: new Map(),
  filters: {},
  offsets: new Map(),
  focusNode: null,
};

function cloneState(state: ViewAdjustmentState): {
  hiddenNodes: Set<string>;
  hiddenEdges: Set<string>;
  renames: Map<string, string>;
  displays: Map<string, { tier?: TopologyTier; kind?: TopologyNode['kind']; product?: string; role?: string }>;
  filters: Partial<Record<ViewFilterKey, boolean>>;
  offsets: Map<string, { x: number; y: number }>;
  focusNode: string | null;
} {
  return {
    hiddenNodes: new Set(state.hiddenNodes),
    hiddenEdges: new Set(state.hiddenEdges),
    renames: new Map(state.renames),
    displays: new Map(state.displays),
    filters: { ...state.filters },
    offsets: new Map(state.offsets),
    focusNode: state.focusNode,
  };
}

/** 按历史顺序重放视图操作；tagEdge 由后端标签持久化承担，这里跳过。 */
export function replayAdjustments(adjustments: readonly TopologyAdjustment[]): ViewAdjustmentState {
  let state: ViewAdjustmentState = EMPTY_ADJUSTMENT_STATE;
  for (const adjustment of adjustments) {
    for (const operation of adjustment.operations) {
      state = applyOperationToState(state, operation);
    }
  }
  return state;
}

export function applyOperationToState(
  state: ViewAdjustmentState,
  operation: TopologyAdjustOperation,
): ViewAdjustmentState {
  const next = cloneState(state);
  switch (operation.op) {
    case 'hideNode':
      next.hiddenNodes.add(operation.nodeId);
      break;
    case 'showNode':
      next.hiddenNodes.delete(operation.nodeId);
      break;
    case 'hideEdge':
      next.hiddenEdges.add(operation.relationKey);
      break;
    case 'showEdge':
      next.hiddenEdges.delete(operation.relationKey);
      break;
    case 'renameNode':
      next.renames.set(operation.nodeId, operation.label);
      break;
    case 'setNodeDisplay': {
      const previous = next.displays.get(operation.nodeId) ?? {};
      next.displays.set(operation.nodeId, {
        ...previous,
        ...(operation.tier ? { tier: operation.tier } : {}),
        ...(operation.kind ? { kind: operation.kind } : {}),
        ...(operation.product ? { product: operation.product } : {}),
        ...(operation.role ? { role: operation.role } : {}),
      });
      break;
    }
    case 'setFilter':
      next.filters[operation.key] = operation.value;
      break;
    case 'focusNode':
      next.focusNode = operation.nodeId;
      break;
    case 'moveNode': {
      const previous = next.offsets.get(operation.nodeId) ?? { x: 0, y: 0 };
      const distance = operation.distance ?? 60;
      const delta =
        operation.direction === 'left'
          ? { x: -distance, y: 0 }
          : operation.direction === 'right'
            ? { x: distance, y: 0 }
            : operation.direction === 'top'
              ? { x: 0, y: -distance }
              : { x: 0, y: distance };
      next.offsets.set(operation.nodeId, { x: previous.x + delta.x, y: previous.y + delta.y });
      break;
    }
    case 'resetView':
      return EMPTY_ADJUSTMENT_STATE;
    case 'tagEdge':
      break;
    default:
      break;
  }
  return next;
}

function externalNode(node: TopologyNode): boolean {
  return node.kind === 'external' || node.tier === 'external' || node.inferred === true;
}

function matchesNodeId(node: TopologyNode, token: string): boolean {
  return node.id === token || node.label === token || node.hostname === token;
}

export interface AdjustedGraphResult {
  readonly graph: TopologyGraph;
  readonly hiddenNodeCount: number;
  readonly hiddenEdgeCount: number;
  readonly manualNodeIds: ReadonlySet<string>;
}

/** 把视图调整落到图数据上：过滤节点/边、应用改名与展示覆盖、外部依赖过滤。 */
export function applyViewAdjustments(
  graph: TopologyGraph,
  state: ViewAdjustmentState,
): AdjustedGraphResult {
  const hiddenIds = new Set<string>();
  for (const token of state.hiddenNodes) {
    for (const node of graph.nodes) {
      if (matchesNodeId(node, token)) hiddenIds.add(node.id);
    }
  }
  const hideExternal = state.filters.external === false;
  const manualNodeIds = new Set<string>();
  const nodes: TopologyNode[] = [];
  for (const node of graph.nodes) {
    if (hiddenIds.has(node.id)) continue;
    if (hideExternal && externalNode(node)) continue;
    const rename = state.renames.get(node.id);
    const display = state.displays.get(node.id);
    if (rename || display) manualNodeIds.add(node.id);
    const note = rename || display
      ? [node.note, '手动调整'].filter(Boolean).join(' · ')
      : node.note;
    nodes.push({
      ...node,
      ...(rename ? { label: rename } : {}),
      ...(display?.tier ? { tier: display.tier } : {}),
      ...(display?.kind ? { kind: display.kind } : {}),
      ...(display?.product ? { product: display.product } : {}),
      ...(display?.role ? { role: display.role } : {}),
      ...(note ? { note } : {}),
    });
  }
  const visible = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) =>
      visible.has(edge.source) &&
      visible.has(edge.target) &&
      !state.hiddenEdges.has(edge.relationKey ?? edge.id),
  );
  return {
    graph: {
      ...graph,
      nodes,
      edges,
      stats: {
        ...graph.stats,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
    },
    hiddenNodeCount: graph.nodes.length - nodes.length,
    hiddenEdgeCount: graph.edges.length - edges.length,
    manualNodeIds,
  };
}

const TIER_LABEL: Record<TopologyTier, string> = {
  access: '接入层',
  app: '应用层',
  middleware: '中间件层',
  data: '数据层',
  ops: '观测层',
  external: '外部依赖',
};

const TIER_TOKEN: Record<string, TopologyTier> = {
  接入: 'access',
  应用: 'app',
  中间件: 'middleware',
  数据: 'data',
  数据库: 'data',
  运维: 'ops',
  监控: 'ops',
  可观测: 'ops',
  外部: 'external',
};

export function operationLabel(operation: TopologyAdjustOperation): string {
  switch (operation.op) {
    case 'hideNode':
      return `隐藏节点 ${operation.nodeId}`;
    case 'showNode':
      return `显示节点 ${operation.nodeId}`;
    case 'hideEdge':
      return `隐藏关系 ${operation.relationKey}`;
    case 'showEdge':
      return `显示关系 ${operation.relationKey}`;
    case 'renameNode':
      return `改名 ${operation.nodeId} → ${operation.label}`;
    case 'setNodeDisplay':
      return `调整 ${operation.nodeId}${operation.tier ? ` · ${TIER_LABEL[operation.tier]}` : ''}${operation.product ? ` · ${operation.product}` : ''}${operation.role ? ` · ${operation.role}` : ''}`;
    case 'tagEdge':
      return `标签 ${operation.label}`;
    case 'setFilter':
      return `${operation.key === 'external' ? '外部依赖' : operation.key === 'management' ? '管理流量' : operation.key === 'lowTraffic' ? '低流量边' : '未归属主机'} ${operation.value ? '显示' : '隐藏'}`;
    case 'focusNode':
      return `聚焦 ${operation.nodeId}`;
    case 'moveNode':
      return `移动 ${operation.nodeId} 向${operation.direction === 'left' ? '左' : operation.direction === 'right' ? '右' : operation.direction === 'top' ? '上' : '下'}`;
    case 'resetView':
      return '重置视图';
    default:
      return '调整';
  }
}

/** 无模型/接口未就绪时的确定性规则解析，覆盖示例指令。 */
export function localAdjustment(
  graphId: string,
  instruction: string,
  graph: TopologyGraph,
): TopologyAdjustment & { clarification?: string } {
  const text = instruction.trim();
  const createdAt = new Date().toISOString();
  const id = `local-adjust-${Date.now()}`;
  const base = {
    id,
    graphId,
    instruction: text,
    model: 'local-rules',
    fallback: true,
    warning: '当前未调用大模型，使用本地规则解析指令；仅影响当前视图与标签。',
    createdAt,
  };

  const nodeToken = (raw: string): string => raw.replace(/^[“"'「『]|[”"'」』，。,.!！]$/g, '').trim();
  const findNode = (raw: string): TopologyNode | null => {
    const token = nodeToken(raw);
    return (
      graph.nodes.find((node) => node.id === token || node.label === token || node.hostname === token) ??
      graph.nodes.find((node) => node.label.includes(token) || token.includes(node.label)) ??
      null
    );
  };

  if (/重置(视图|微调)?/.test(text)) {
    return { ...base, reply: '已清空本地视图调整（改名、过滤、聚焦、位移），标签保持不变。', operations: [{ op: 'resetView' }] };
  }

  if (/(隐藏|关闭).{0,4}外部(依赖)?/.test(text)) {
    return {
      ...base,
      reply: '已隐藏外部依赖节点与相关边；可在「微调历史」撤销。',
      operations: [{ op: 'setFilter', key: 'external', value: false }],
    };
  }
  if (/(显示|打开).{0,4}外部(依赖)?/.test(text)) {
    return {
      ...base,
      reply: '已恢复显示外部依赖节点与相关边。',
      operations: [{ op: 'setFilter', key: 'external', value: true }],
    };
  }

  const tagMatch = text.match(/给\s*(.+?)\s*(?:→|->)\s*(.+?):(\d+)\s*打标签\s*[:：]\s*(.+)$/);
  if (tagMatch) {
    const sourceToken = nodeToken(tagMatch[1] ?? '');
    const targetToken = nodeToken(tagMatch[2] ?? '');
    const port = Number(tagMatch[3]);
    const label = (tagMatch[4] ?? '').trim();
    const edge = graph.edges.find((item) => {
      const source = graph.nodes.find((node) => node.id === item.source);
      const target = graph.nodes.find((node) => node.id === item.target);
      const sourceHit = source && (source.label === sourceToken || source.hostname === sourceToken || source.id === sourceToken);
      const targetHit = target && (target.label === targetToken || target.hostname === targetToken || target.id === targetToken);
      return sourceHit && targetHit && item.port === port;
    });
    if (!edge || !edge.relationKey) {
      return {
        ...base,
        reply: '没有找到这条访问关系，请确认源、目标与端口是否在当前图中。',
        operations: [],
        clarification: `未找到 ${sourceToken} → ${targetToken}:${port}，请给出图中存在的主机名或端口。`,
      };
    }
    return {
      ...base,
      reply: `已给 ${sourceToken} → ${targetToken}:${port} 打上标签「${label}」。`,
      operations: [{ op: 'tagEdge', relationKey: edge.relationKey, label, category: '其他' }],
    };
  }

  const renameMatch = text.match(/(?:把|将)?\s*(.+?)\s*(?:改名为|重命名为|改名)\s*([^\s，。,.]+)/);
  if (renameMatch) {
    const node = findNode(renameMatch[1] ?? '');
    if (!node) {
      return {
        ...base,
        reply: '没有找到要改名的节点。',
        operations: [],
        clarification: '请明确节点名，例如「把 prod-db-01 改名为 订单数据库」。',
      };
    }
    return {
      ...base,
      reply: `已将 ${node.label} 在当前视图中改名为「${nodeToken(renameMatch[2] ?? '')}」。`,
      operations: [{ op: 'renameNode', nodeId: node.id, label: nodeToken(renameMatch[2] ?? '') }],
    };
  }

  const tierMatch = text.match(/(?:把|将)?\s*(.+?)\s*(?:改到|放到|调整到|设为|归到)\s*(接入|应用|中间件|数据|数据库|运维|监控|外部)(?:层)?/);
  if (tierMatch) {
    const node = findNode(tierMatch[1] ?? '');
    const tier = TIER_TOKEN[tierMatch[2] ?? ''];
    if (!node || !tier) {
      return {
        ...base,
        reply: '没有找到要调整分层的节点。',
        operations: [],
        clarification: '请明确节点与目标分层，例如「把 prod-db-01 改到数据层」。',
      };
    }
    return {
      ...base,
      reply: `已将 ${node.label} 调整到「${TIER_LABEL[tier]}」（仅当前视图，手动标记）。`,
      operations: [{ op: 'setNodeDisplay', nodeId: node.id, tier }],
    };
  }

  const focusMatch = text.match(/(?:只看|聚焦|查看)\s*(.+)$/);
  if (focusMatch) {
    const node = findNode(focusMatch[1] ?? '');
    if (!node) {
      return {
        ...base,
        reply: '没有找到要聚焦的节点。',
        operations: [],
        clarification: '请给出图中存在的节点名，例如「只看 prod-db-01」。',
      };
    }
    return {
      ...base,
      reply: `已聚焦 ${node.label} 的 1 跳上下游关系。`,
      operations: [{ op: 'focusNode', nodeId: node.id }],
    };
  }

  const moveMatch = text.match(/(?:把|将)?\s*(.+?)\s*(?:向|往)?\s*(左|右|上|下)\s*(?:移动|移)/);
  if (moveMatch) {
    const node = findNode(moveMatch[1] ?? '');
    if (!node) {
      return {
        ...base,
        reply: '没有找到要移动的节点。',
        operations: [],
        clarification: '请给出节点名与方向，例如「把 prod-db-01 向右移动」。',
      };
    }
    return {
      ...base,
      reply: `已把 ${node.label} 向${moveMatch[2]}微移，叠加在手动拖动位置上。`,
      operations: [
        {
          op: 'moveNode',
          nodeId: node.id,
          direction: moveMatch[2] === '左' ? 'left' : moveMatch[2] === '右' ? 'right' : moveMatch[2] === '上' ? 'top' : 'bottom',
          distance: 60,
        },
      ],
    };
  }

  const hideMatch = text.match(/(?:隐藏|关闭)\s*(.+)$/);
  if (hideMatch) {
    const node = findNode(hideMatch[1] ?? '');
    if (node) {
      return {
        ...base,
        reply: `已在当前视图中隐藏 ${node.label} 及其相关边。`,
        operations: [{ op: 'hideNode', nodeId: node.id }],
      };
    }
  }
  const showMatch = text.match(/(?:显示|恢复)\s*(.+)$/);
  if (showMatch) {
    const node = findNode(showMatch[1] ?? '');
    if (node) {
      return {
        ...base,
        reply: `已恢复显示 ${node.label}。`,
        operations: [{ op: 'showNode', nodeId: node.id }],
      };
    }
  }

  return {
    ...base,
    reply: '我还不能准确理解这条指令。可以试试：隐藏外部依赖、只看某台主机、改名、调整分层、给访问关系打标签或重置视图。',
    operations: [],
    clarification: '请补充要操作的具体节点/关系与目标，例如「把 prod-db-01 改名为 订单数据库」。',
  };
}
