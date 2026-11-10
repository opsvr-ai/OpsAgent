/**
 * 访问拓扑共享契约（控制面 / Web / 分析器共用）。
 *
 * 数据链路：
 *   Agent 连接采样 → ConnectionWindowReport[]（心跳）
 *   → agent_connection_edges（窗口样本）
 *   → 学习会话窗口聚合 → TopologyLearningInput
 *   → 大模型/启发式分析器 → TopologyDraft
 *   → topology_graphs（TopologyGraph）→ Web 渲染
 */

/** 学习/拓扑的作用范围：整个租户，或某个应用系统。 */
export type TopologyScopeKind = 'tenant' | 'app-system';

/** 拓扑分层：接入 / 应用 / 中间件 / 数据 / 外部依赖 / 基础设施。 */
export type TopologyTier = 'ingress' | 'app' | 'middleware' | 'data' | 'external' | 'infra';

/** 节点角色分类。 */
export type TopologyNodeKind =
  | 'gateway'
  | 'service'
  | 'database'
  | 'cache'
  | 'mq'
  | 'storage'
  | 'external'
  | 'unknown';

export type TopologyNodeStatus = 'online' | 'offline' | 'unknown';

/** 学习会话状态机。 */
export type TopologyLearningStatus =
  | 'collecting'
  | 'aggregating'
  | 'analyzing'
  | 'ready'
  | 'failed'
  | 'cancelled';

/** 主机上监听的端口与服务。 */
export interface TopologyServicePort {
  readonly name: string;
  readonly port: number;
  readonly process?: string;
  readonly pid?: number;
}

/** 拓扑节点（主机视图时是一台主机，业务系统视图时是一个系统）。 */
export interface TopologyNode {
  readonly id: string;
  readonly label: string;
  readonly kind: TopologyNodeKind;
  readonly tier: TopologyTier;
  readonly hostname?: string;
  readonly ip?: string;
  readonly appSystemId?: string | null;
  readonly appSystemName?: string;
  readonly status: TopologyNodeStatus;
  readonly services: readonly TopologyServicePort[];
  readonly metrics: TopologyNodeMetrics;
  readonly anomalies?: readonly string[];
  /** true 表示节点不是从纳管主机直接得到，而是模型/外部依赖推断出来的。 */
  readonly inferred?: boolean;
  readonly note?: string;
}

export interface TopologyNodeMetrics {
  readonly active: number;
  readonly opened: number;
  readonly closed: number;
  readonly failed: number;
  readonly inbound: number;
  readonly outbound: number;
}

/** 拓扑边：source → target 的访问关系。 */
export interface TopologyEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly protocol: string;
  readonly port: number;
  readonly label?: string;
  /** 窗口内观测到的连接数（并发 + 新建的合计口径，见 countBasis）。 */
  readonly count: number;
  readonly countBasis?: 'opened' | 'active' | 'observed';
  readonly opened: number;
  readonly failed: number;
  /** 0~1，模型推断边低于观测边。 */
  readonly confidence: number;
  readonly direction?: 'out' | 'in' | 'both';
  readonly processes?: readonly string[];
  readonly lastSeen?: string;
  readonly external?: boolean;
}

export interface TopologyHotPath {
  readonly label: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly connections: number;
}

export type TopologyInsightSeverity = 'info' | 'warning' | 'critical';

export interface TopologyInsight {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: TopologyInsightSeverity;
  readonly nodeIds?: readonly string[];
  readonly edgeIds?: readonly string[];
}

/** 服务端大模型/启发式分析结论。 */
export interface TopologyAnalysis {
  readonly summary: string;
  readonly insights: readonly TopologyInsight[];
  readonly hotPaths: readonly TopologyHotPath[];
  readonly risks: readonly TopologyInsight[];
  readonly model: string;
  readonly promptVersion: string;
  readonly generatedAt: string;
  readonly confidence: number;
  readonly durationMs?: number;
  /** true 表示模型不可用/输出非法，使用确定性启发式生成。 */
  readonly fallback?: boolean;
  readonly warning?: string;
}

/** 业务系统分组（Web 用来画分组色带 / 系统视图）。 */
export interface TopologySystemGroup {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly nodeIds: readonly string[];
  readonly criticality?: string;
}

export interface TopologyWindow {
  readonly start: string;
  readonly end: string;
  readonly seconds: number;
}

export interface TopologyScope {
  readonly kind: TopologyScopeKind;
  readonly appSystemId?: string | null;
  readonly appSystemName?: string;
}

export interface TopologyGraphStats {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly hostCount: number;
  readonly systemCount: number;
  readonly externalCount: number;
  readonly totalConnections: number;
  readonly failedConnections: number;
  readonly samples: number;
  readonly reportingAgents: number;
}

/** 一次学习生成的最终拓扑图。 */
export interface TopologyGraph {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly scope: TopologyScope;
  readonly mode: 'host' | 'app-system';
  readonly window: TopologyWindow;
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly systems: readonly TopologySystemGroup[];
  readonly analysis: TopologyAnalysis;
  readonly stats: TopologyGraphStats;
  readonly createdAt: string;
  readonly version: number;
}

export interface TopologyLearningProgress {
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
  readonly percent: number;
  readonly reportingAgents: number;
  readonly expectedAgents: number;
  readonly edgeSamples: number;
  readonly uniqueEdges: number;
  readonly phase: string;
}

/** 固定时间窗学习会话。 */
export interface TopologyLearningSession {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: TopologyScope;
  readonly windowSeconds: number;
  readonly status: TopologyLearningStatus;
  readonly startedAt: string;
  readonly endsAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progress: TopologyLearningProgress;
  readonly graphId?: string | null;
  readonly model?: string | null;
  readonly fallback?: boolean;
  readonly error?: string | null;
  readonly stats?: TopologyGraphStats;
}

/** 自动学习策略（每个租户一条，scope 可选择整个租户或某应用系统）。 */
export interface TopologyLearningPolicy {
  readonly tenantId: string;
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly windowSeconds: number;
  readonly scope: TopologyScope;
  readonly lastRunAt?: string | null;
  readonly nextRunAt?: string | null;
  readonly updatedAt: string;
}

export interface TopologyLearningPolicyUpdate {
  readonly enabled?: boolean;
  readonly intervalSeconds?: number;
  readonly windowSeconds?: number;
  readonly scope?: TopologyScope;
}

/** 创建学习会话请求。 */
export interface TopologyLearnRequest {
  readonly appSystemId?: string | null;
  readonly windowSeconds?: number;
}

// ---------------------------------------------------------------------------
// Agent 上报契约（Go Agent 心跳里的 connectionWindows 字段，字段名必须一致）
// ---------------------------------------------------------------------------

export interface ConnectionEdgeReport {
  readonly direction: 'out' | 'in';
  readonly process: string;
  readonly pid: number;
  readonly service: string;
  readonly command: string;
  readonly localAddress: string;
  readonly localPort: number;
  readonly peerAddress: string;
  readonly peerPort: number;
  readonly protocol: string;
  readonly opened: number;
  readonly closed: number;
  readonly failed: number;
  readonly active: number;
  readonly firstSeen?: string;
  readonly lastSeen?: string;
  readonly container?: string;
  readonly baseline?: boolean;
}

export interface ConnectionWindowReport {
  readonly start: string;
  readonly end: string;
  readonly source: 'procfs' | 'ebpf' | 'hybrid';
  readonly edges: readonly ConnectionEdgeReport[];
  readonly stats?: {
    readonly scans?: number;
    readonly activeConnections?: number;
    readonly dropped?: number;
  };
}

// ---------------------------------------------------------------------------
// 学习输入（控制面聚合后交给分析器）
// ---------------------------------------------------------------------------

export interface TopologyLearningHost {
  readonly agentId: string;
  readonly hostname: string;
  readonly ip: string;
  readonly appSystemId: string | null;
  readonly appSystemName: string;
  readonly status: string;
  readonly os?: string;
  readonly services: readonly TopologyServicePort[];
  readonly anomalies: readonly string[];
}

export interface TopologyLearningEdge {
  readonly fromAgentId: string;
  readonly fromHost: string;
  readonly fromService: string;
  readonly fromProcess: string;
  readonly toAgentId: string | null;
  readonly toHost: string;
  readonly toIp: string;
  readonly toPort: number;
  readonly toService: string;
  readonly direction: 'out' | 'in' | 'both';
  readonly opened: number;
  readonly closed: number;
  readonly failed: number;
  readonly active: number;
  readonly protocol: string;
  readonly lastSeen?: string;
  readonly targetAppSystemId?: string | null;
  readonly targetAppSystemName?: string;
  readonly external?: boolean;
}

export interface TopologyExternalPeer {
  readonly ip: string;
  readonly port: number;
  readonly processes: readonly string[];
  readonly opened: number;
  readonly failed: number;
  readonly note?: string;
}

export interface TopologyLearningInput {
  readonly scope: TopologyScope;
  readonly window: TopologyWindow;
  readonly hosts: readonly TopologyLearningHost[];
  readonly edges: readonly TopologyLearningEdge[];
  readonly externalPeers: readonly TopologyExternalPeer[];
  readonly stats: TopologyGraphStats;
}

/** 分析器输出（模型 JSON 解析后的中间结构）。 */
export interface TopologyDraftNode {
  readonly id: string;
  readonly label: string;
  readonly kind: TopologyNodeKind;
  readonly tier: TopologyTier;
  readonly hostname?: string;
  readonly ip?: string;
  readonly appSystemId?: string | null;
  readonly appSystemName?: string;
  readonly status?: TopologyNodeStatus;
  readonly services?: readonly TopologyServicePort[];
  readonly inferred?: boolean;
  readonly note?: string;
}

export interface TopologyDraftEdge {
  readonly source: string;
  readonly target: string;
  readonly port: number;
  readonly count: number;
  readonly opened?: number;
  readonly failed?: number;
  readonly protocol?: string;
  readonly label?: string;
  readonly confidence?: number;
}

export interface TopologyDraft {
  readonly nodes: readonly TopologyDraftNode[];
  readonly edges: readonly TopologyDraftEdge[];
  readonly insights?: readonly TopologyInsight[];
  readonly hotPaths?: readonly TopologyHotPath[];
  readonly risks?: readonly TopologyInsight[];
  readonly summary?: string;
  readonly systems?: readonly TopologySystemGroup[];
  readonly confidence?: number;
}

/** API 返回的学习会话 + 拓扑列表项。 */
export interface TopologyGraphSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly scope: TopologyScope;
  readonly mode: 'host' | 'app-system';
  readonly window: TopologyWindow;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly totalConnections: number;
  readonly failedConnections: number;
  readonly model: string;
  readonly fallback?: boolean;
  readonly createdAt: string;
  readonly version: number;
  readonly summary: string;
}
