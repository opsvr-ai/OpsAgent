import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type {
  TopologyGraph,
  TopologyGraphSummary,
  TopologyInsight,
  TopologyLearningPolicy,
  TopologyLearningPolicyUpdate,
  TopologyLearningSession,
} from '@opsagent/contracts';
import {
  ApiError,
  getActiveTopologySession,
  getLatestTopology,
  getTopologyGraph,
  getTopologyGraphs,
  getTopologyPolicy,
  getTopologySession,
  analyzeTopologySession,
  cancelTopologySession,
  listAppSystems,
  listAvailableModels,
  startTopologyLearning,
  updateTopologyPolicy,
} from '../api/client.js';
import { relativeTime } from '../format.js';
import { ThemeToggle } from '../theme/use-theme.js';
import { AppSidebar } from './app-sidebar.js';
import {
  buildViewGraph,
  computeLayout,
  isUnassignedSystemName,
  matchNodeIds,
  truncateText,
  type TopoViewMode,
} from '../topology/layout.js';
import { TopologyCanvas, type CenterTarget } from '../topology/topology-canvas.js';
import { AnalysisPanel, NodeDetailPanel } from '../topology/analysis-panel.js';
import { LearningWizard, PolicyPanel, type AppSystemOption } from '../topology/learning.js';
import { MiniIcon } from '../topology/icons.js';
import {
  DEMO_APP_SYSTEMS,
  DEMO_DENSE_APP_SYSTEMS,
  DEMO_DENSE_GRAPH,
  DEMO_DENSE_SUMMARIES,
  DEMO_GRAPH,
  DEMO_GRAPH_SUMMARIES,
  DEMO_POLICY,
  advanceDemoSession,
  demoGraphById,
  demoLearningSession,
  demoNextGraph,
  demoPolicy,
} from '../topology/demo.js';
import {
  DEFAULT_DISPLAY_SETTINGS,
  buildRelatedNodes,
  filterGraphByScope,
  loadDisplaySettings,
  prepareTopology,
  saveDisplaySettings,
  splitServices,
  type ExternalGroupInfo,
  type TopologyDisplaySettings,
} from '../topology/v3.js';
import './topology.css';

export interface TopologyProps {
  readonly onBack?: () => void;
  readonly demo?: boolean;
}

type LoadError = {
  readonly kind: 'unauthorized' | 'unavailable';
  readonly message: string;
} | null;

type Toast = {
  readonly kind: 'ok' | 'warn' | 'error';
  readonly text: string;
  readonly id: number;
} | null;

const RUNNING_STATUS = new Set(['collecting', 'aggregating', 'analyzing']);

function intervalLabel(seconds: number): string {
  if (seconds >= 86_400) return '每 24 小时';
  if (seconds >= 43_200) return '每 12 小时';
  if (seconds >= 21_600) return '每 6 小时';
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
}

function summaryOf(graph: TopologyGraph): TopologyGraphSummary {
  return {
    id: graph.id,
    sessionId: graph.sessionId,
    scope: graph.scope,
    mode: graph.mode,
    window: graph.window,
    nodeCount: graph.stats.nodeCount,
    edgeCount: graph.stats.edgeCount,
    totalConnections: graph.stats.totalConnections,
    failedConnections: graph.stats.failedConnections,
    model: graph.analysis.model,
    fallback: graph.analysis.fallback ?? false,
    createdAt: graph.createdAt,
    version: graph.version,
    summary: graph.analysis.summary,
  };
}

function timeOf(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function Topology({ onBack, demo = false }: TopologyProps): ReactElement {
  const denseCase = demo && new URLSearchParams(window.location.search).get('case') === 'dense';
  const initialGraph = denseCase ? DEMO_DENSE_GRAPH : DEMO_GRAPH;
  const initialSummaries = denseCase ? DEMO_DENSE_SUMMARIES : DEMO_GRAPH_SUMMARIES;
  const initialSystems = denseCase ? DEMO_DENSE_APP_SYSTEMS : DEMO_APP_SYSTEMS;
  const [graph, setGraph] = useState<TopologyGraph | null>(demo ? initialGraph : null);
  const [graphList, setGraphList] = useState<TopologyGraphSummary[]>(demo ? [...initialSummaries] : []);
  const [appSystems, setAppSystems] = useState<readonly AppSystemOption[]>(demo ? initialSystems : []);
  const [policy, setPolicy] = useState<TopologyLearningPolicy | null>(demo ? DEMO_POLICY : null);
  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState<LoadError>(null);
  const [scopeId, setScopeId] = useState('');
  const [historyId, setHistoryId] = useState(demo ? initialGraph.id : '');
  const [viewMode, setViewMode] = useState<TopoViewMode>('host');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drillSystemId, setDrillSystemId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterAnomaly, setFilterAnomaly] = useState(false);
  const [filterCross, setFilterCross] = useState(false);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [displaySettings, setDisplaySettings] = useState<TopologyDisplaySettings>(() =>
    demo ? DEFAULT_DISPLAY_SETTINGS : loadDisplaySettings(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [keepFullView, setKeepFullView] = useState(false);
  const [fitEpoch, setFitEpoch] = useState(0);
  const [modelAvailable, setModelAvailable] = useState<boolean | null>(null);
  const [analysisNodeIds, setAnalysisNodeIds] = useState<readonly string[] | null>(null);
  const [analysisEdgeIds, setAnalysisEdgeIds] = useState<readonly string[] | null>(null);
  const [activeHotPath, setActiveHotPath] = useState<number | null>(null);
  const [activeInsightId, setActiveInsightId] = useState<string | null>(null);
  const [centerTarget, setCenterTarget] = useState<CenterTarget | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [session, setSession] = useState<TopologyLearningSession | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const toastSeq = useRef(0);
  const centerEpoch = useRef(0);
  const finishedSessionRef = useRef<string | null>(null);

  const showToast = useCallback((kind: 'ok' | 'warn' | 'error', text: string): void => {
    toastSeq.current += 1;
    setToast({ kind, text, id: toastSeq.current });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const centerOn = useCallback((ids: readonly string[]): void => {
    if (ids.length === 0) return;
    centerEpoch.current += 1;
    setCenterTarget({ ids, epoch: centerEpoch.current });
  }, []);

  const loadErrorFrom = (error: unknown): LoadError => {
    if (error instanceof ApiError && error.status === 401) {
      return { kind: 'unauthorized', message: '登录状态已失效，请重新登录后再查看访问拓扑。' };
    }
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    return {
      kind: 'unavailable',
      message: '拓扑服务暂不可用或接口尚未上线。可以稍后重试，或先运行一次学习生成拓扑。',
    };
  };

  const loadTopology = useCallback(async (): Promise<void> => {
    if (demo) {
      setGraph(initialGraph ? filterGraphByScope(initialGraph, scopeId || null) : null);
      setGraphList([...initialSummaries]);
      setHistoryId(initialGraph.id);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const listResult = await getTopologyGraphs().catch(() => ({ graphs: [] as TopologyGraphSummary[] }));
      setGraphList(listResult.graphs);
      // 版本列表里优先挑与当前范围一致的图：应用系统范围优先精确 scope 的图；
      // 全部范围优先 tenant 图。没有匹配时取最新图，再按范围裁剪。
      const preferred = scopeId
        ? listResult.graphs.find((item) => item.scope.kind === 'app-system' && item.scope.appSystemId === scopeId)
        : listResult.graphs.find((item) => item.scope.kind === 'tenant');
      let latest = preferred
        ? await getTopologyGraph(preferred.id).catch(() => null)
        : null;
      if (!latest) latest = await getLatestTopology();
      if (!latest && listResult.graphs[0]) {
        latest = await getTopologyGraph(listResult.graphs[0].id).catch(() => null);
      }
      setGraph(latest ? filterGraphByScope(latest, scopeId || null) : null);
      setHistoryId(latest?.id ?? '');
    } catch (error) {
      setLoadError(loadErrorFrom(error));
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }, [demo, initialGraph, initialSummaries, scopeId]);

  useEffect(() => {
    void loadTopology();
  }, [loadTopology]);

  useEffect(() => {
    if (demo) {
      setAppSystems(initialSystems);
      setPolicy(DEMO_POLICY);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const systems = await listAppSystems();
        if (!cancelled) setAppSystems(systems.map((system) => ({ id: system.id, name: system.name })));
      } catch {
        // 应用系统列表失败不影响拓扑展示。
      }
      try {
        const result = await getTopologyPolicy();
        if (!cancelled) setPolicy(result);
      } catch {
        // 策略接口未上线时保持关闭状态。
      }
      try {
        const active = await getActiveTopologySession(scopeId || undefined);
        if (!cancelled && active && RUNNING_STATUS.has(active.status)) {
          setSession(active);
          setWizardOpen(true);
        }
      } catch {
        // 没有进行中的学习会话。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, initialSystems, scopeId]);

  // 切换范围 / 版本时清空画布上的临时高亮。
  useEffect(() => {
    setSelectedId(null);
    setFocusId(null);
    setDrillSystemId(null);
    setAnalysisNodeIds(null);
    setAnalysisEdgeIds(null);
    setActiveHotPath(null);
    setActiveInsightId(null);
    setSearch('');
    setFilterAnomaly(false);
    setFilterCross(false);
  }, [scopeId, historyId]);

  const finishLearning = useCallback(
    async (done: TopologyLearningSession): Promise<void> => {
      if (demo) {
        const nextVersion = (graph?.version ?? 0) + 1;
        const nextGraph = demoNextGraph(nextVersion);
        setGraph(filterGraphByScope(nextGraph, scopeId || null));
        setGraphList((current) => [summaryOf(nextGraph), ...current]);
        setHistoryId(nextGraph.id);
        showToast('ok', `已生成第 ${nextVersion} 版拓扑`);
        return;
      }
      try {
        const [list, latest] = await Promise.all([
          getTopologyGraphs().catch(() => ({ graphs: [] as TopologyGraphSummary[] })),
          getLatestTopology(),
        ]);
        setGraphList(list.graphs);
        if (latest) {
          // 若刚完成的是某个应用系统的学习，自动把范围切到该系统，避免全部范围
          // 只加载到这份 scoped 图。
          const nextScope = latest.scope.kind === 'app-system'
            ? latest.scope.appSystemId ?? ''
            : scopeId;
          if (nextScope !== scopeId) setScopeId(nextScope);
          setGraph(filterGraphByScope(latest, nextScope || null));
          setHistoryId(latest.id);
          showToast('ok', `已生成第 ${latest.version} 版拓扑`);
        } else {
          showToast('warn', '学习完成，但还没有取到拓扑版本，请手动刷新。');
        }
      } catch {
        showToast('warn', '学习完成，但刷新拓扑失败，请稍后重试。');
      }
    },
    [demo, graph?.version, scopeId, showToast],
  );

  useEffect(() => {
    if (!session || session.status !== 'ready') return;
    if (finishedSessionRef.current === session.id) return;
    finishedSessionRef.current = session.id;
    void finishLearning(session);
  }, [finishLearning, session]);

  // 演示模式：本地推进进度，约 20 秒走完一个窗口。
  useEffect(() => {
    if (!demo || !session) return;
    if (session.status !== 'collecting') return;
    const step = Math.max(1, Math.ceil(session.windowSeconds / 20));
    const timer = window.setInterval(() => {
      setSession((current) => (current ? advanceDemoSession(current, step) : current));
    }, 900);
    return () => window.clearInterval(timer);
  }, [demo, session?.id, session?.status, session?.windowSeconds]);

  // 真实模式：轮询学习会话，完成/失败后自动刷新。
  useEffect(() => {
    if (demo || !session) return;
    if (!RUNNING_STATUS.has(session.status)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getTopologySession(session.id)
        .then((next) => {
          if (!cancelled) setSession(next);
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [demo, session?.id, session?.status]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (settingsOpen) setSettingsOpen(false);
      else if (policyOpen) setPolicyOpen(false);
      else if (wizardOpen && !(session && RUNNING_STATUS.has(session.status))) setWizardOpen(false);
      else if (fullscreen) setFullscreen(false);
      else if (selectedId) {
        setSelectedId(null);
        setFocusId(null);
      } else if (focusId) setFocusId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusId, fullscreen, policyOpen, selectedId, session, settingsOpen, wizardOpen]);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void listAvailableModels()
      .then((models) => {
        if (!cancelled) setModelAvailable(models.length > 0);
      })
      .catch(() => {
        if (!cancelled) setModelAvailable(null);
      });
    return () => {
      cancelled = true;
    };
  }, [demo]);

  useEffect(() => {
    saveDisplaySettings(displaySettings);
  }, [displaySettings]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.topo-settings-pop') || target?.closest('[aria-haspopup="dialog"]')) return;
      setSettingsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [settingsOpen]);

  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  const prepared = useMemo(
    () => (graph ? prepareTopology(graph, displaySettings, showUnassigned) : null),
    [displaySettings, graph, showUnassigned],
  );
  const view = useMemo(
    () =>
      prepared
        ? buildViewGraph(prepared.graph, viewMode, { includeUnassigned: showUnassigned })
        : null,
    [prepared, showUnassigned, viewMode],
  );
  const layout = useMemo(
    () => (view ? computeLayout(view, { compactCards: displaySettings.compactCards }) : null),
    [displaySettings.compactCards, view],
  );
  const systemColors = useMemo(
    () => new Map((layout?.systemLegend ?? []).map((system) => [system.id, system.color])),
    [layout],
  );
  const selectedNode = useMemo(
    () => (selectedId && layout ? layout.nodeById.get(selectedId) ?? null : null),
    [layout, selectedId],
  );
  const externalGroup: ExternalGroupInfo | null =
    selectedId && prepared ? prepared.externalGroups.get(selectedId) ?? null : null;
  const relatedNodes = useMemo(
    () =>
      prepared && selectedId
        ? buildRelatedNodes(prepared.graph.edges, prepared.graph.nodes, selectedId)
        : { outgoing: [], incoming: [] },
    [prepared, selectedId],
  );
  const selectedNodeServices = useMemo(
    () => (selectedNode ? splitServices(selectedNode.node.services) : { business: [], management: [] }),
    [selectedNode],
  );
  const neighbourhood = useMemo(() => {
    if (!layout || !selectedId) return new Set<string>();
    const ids = new Set<string>([selectedId]);
    for (const edge of layout.edges) {
      if (edge.sourceId === selectedId) ids.add(edge.targetId);
      if (edge.targetId === selectedId) ids.add(edge.sourceId);
    }
    return ids;
  }, [layout, selectedId]);
  // 点击节点后自动 fit 该节点的 ego network（可在详情里切换「保持全图」）。
  useEffect(() => {
    if (!selectedId || keepFullView || neighbourhood.size === 0) return;
    setCenterTarget((previous) => ({
      ids: [...neighbourhood],
      epoch: (previous?.epoch ?? 0) + 1,
    }));
  }, [keepFullView, neighbourhood, selectedId]);


  const matchCount = useMemo(() => {
    if (!layout || !search.trim()) return 0;
    return matchNodeIds(layout, search).size;
  }, [layout, search]);

  const topLinks = useMemo(() => (layout ? layout.edges.slice(0, 3) : []), [layout]);

  const systemViewStats = useMemo(() => {
    if (!view || viewMode !== 'system') return null;
    const businessSystemIds = new Set(
      view.nodes
        .filter((item) => item.aggregated && !isUnassignedSystemName(item.node.label))
        .map((item) => item.node.id),
    );
    const interSystemEdges = view.edges.filter(
      (edge) => businessSystemIds.has(edge.source) && businessSystemIds.has(edge.target),
    );
    return {
      systems: businessSystemIds.size,
      edges: interSystemEdges.length,
      connections: interSystemEdges.reduce((sum, edge) => sum + edge.count, 0),
      failed: interSystemEdges.reduce((sum, edge) => sum + edge.failed, 0),
      external: view.nodes.filter((item) => item.node.kind === 'external' || item.node.inferred === true).length,
      unassigned: view.nodes.filter(
        (item) => item.aggregated && isUnassignedSystemName(item.node.label),
      ).length,
    };
  }, [view, viewMode]);

  const hostStats = {
    nodes: layout?.nodes.length ?? 0,
    edges: layout?.edges.length ?? 0,
    connections: layout?.totalConnections ?? 0,
    failed: layout?.failedConnections ?? 0,
    systems: layout ? layout.systemLegend.filter((system) => !isUnassignedSystemName(system.name)).length : 0,
    external:
      graph?.stats.externalCount ??
      (layout ? layout.nodes.filter((node) => node.node.kind === 'external' || node.node.inferred === true).length : 0),
  };

  const startLearning = useCallback(
    async (input: { appSystemId: string | null; windowSeconds: number; includeUnassigned: boolean }): Promise<void> => {
      setBusy(true);
      setWizardError(null);
      finishedSessionRef.current = null;
      try {
        if (demo) {
          setSession(demoLearningSession(input.windowSeconds, input.appSystemId, 0, input.includeUnassigned));
        } else {
          const created = await startTopologyLearning({
            appSystemId: input.appSystemId,
            windowSeconds: input.windowSeconds,
            includeUnassigned: input.includeUnassigned,
          });
          setSession(created);
        }
      } catch (error) {
        setWizardError(
          error instanceof ApiError && error.status === 401
            ? '登录状态已失效，请重新登录。'
            : '无法开始学习，拓扑学习接口可能尚未上线。',
        );
      } finally {
        setBusy(false);
      }
    },
    [demo],
  );

  const cancelLearning = useCallback(async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setWizardError(null);
    try {
      if (demo) {
        setSession(null);
        showToast('warn', '已取消本次学习');
      } else {
        const next = await cancelTopologySession(session.id);
        setSession(next);
      }
    } catch {
      setWizardError('取消失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }, [demo, session, showToast]);

  const retryLearning = useCallback(async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setWizardError(null);
    finishedSessionRef.current = null;
    if (demo) {
      setSession({ ...session, status: 'analyzing', error: null });
      window.setTimeout(() => {
        setSession((current) =>
          current
            ? {
                ...current,
                status: 'ready',
                error: null,
                graphId: DEMO_GRAPH.id,
                progress: { ...current.progress, percent: 1, remainingSeconds: 0, phase: 'ready' },
              }
            : current,
        );
      }, 1400);
      setBusy(false);
      return;
    }
    try {
      const next = await analyzeTopologySession(session.id);
      setSession(next);
    } catch {
      setWizardError('重试分析失败，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }, [demo, session]);

  const savePolicy = useCallback(
    async (input: TopologyLearningPolicyUpdate): Promise<void> => {
      setPolicySaving(true);
      setPolicyError(null);
      try {
        if (demo) {
          const next = demoPolicy({
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
            ...(input.windowSeconds !== undefined ? { windowSeconds: input.windowSeconds } : {}),
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            ...(input.includeUnassigned !== undefined ? { includeUnassigned: input.includeUnassigned } : {}),
            nextRunAt: new Date(
              Date.now() + (input.intervalSeconds ?? policy?.intervalSeconds ?? 21_600) * 1000,
            ).toISOString(),
          });
          setPolicy(next);
          setPolicyOpen(false);
          showToast('ok', '自动学习策略已保存（演示）');
        } else {
          const next = await updateTopologyPolicy(input);
          setPolicy(next);
          setPolicyOpen(false);
          showToast('ok', '自动学习策略已保存');
        }
      } catch {
        setPolicyError('保存失败，策略接口可能尚未上线。');
      } finally {
        setPolicySaving(false);
      }
    },
    [demo, policy?.intervalSeconds, showToast],
  );

  const focusHotPath = useCallback(
    (index: number): void => {
      if (!graph) return;
      const path = graph.analysis.hotPaths[index];
      if (!path) return;
      if (activeHotPath === index) {
        setActiveHotPath(null);
        setAnalysisNodeIds(null);
        setAnalysisEdgeIds(null);
        return;
      }
      setActiveHotPath(index);
      setActiveInsightId(null);
      setAnalysisNodeIds(path.nodeIds);
      setAnalysisEdgeIds(path.edgeIds);
      setSelectedId(null);
      setFocusId(null);
      centerOn(path.nodeIds);
    },
    [activeHotPath, centerOn, graph],
  );

  const focusInsight = useCallback(
    (insight: TopologyInsight): void => {
      if (activeInsightId === insight.id) {
        setActiveInsightId(null);
        setAnalysisNodeIds(null);
        setAnalysisEdgeIds(null);
        return;
      }
      setActiveInsightId(insight.id);
      setActiveHotPath(null);
      setAnalysisNodeIds(insight.nodeIds ?? null);
      setAnalysisEdgeIds(insight.edgeIds ?? null);
      setSelectedId(null);
      setFocusId(null);
      if (insight.nodeIds && insight.nodeIds.length > 0) centerOn(insight.nodeIds.slice(0, 4));
    },
    [activeInsightId, centerOn],
  );

  const clearAnalysis = useCallback((): void => {
    setAnalysisNodeIds(null);
    setAnalysisEdgeIds(null);
    setActiveHotPath(null);
    setActiveInsightId(null);
  }, []);

  const focusEdgeGroup = useCallback(
    (edgeIds: readonly string[], nodeIds: readonly string[]): void => {
      setAnalysisEdgeIds(edgeIds);
      setAnalysisNodeIds(nodeIds);
      setActiveHotPath(null);
      setActiveInsightId(null);
      centerOn(nodeIds);
    },
    [centerOn],
  );

  const handleSelect = useCallback((id: string | null): void => {
    if (!id) {
      setSelectedId(null);
      setFocusId(null);
      setAnalysisNodeIds(null);
      setAnalysisEdgeIds(null);
      setActiveHotPath(null);
      setActiveInsightId(null);
      return;
    }
    setSelectedId(id);
    setFocusId(id);
    setRailOpen(true);
    setAnalysisNodeIds(null);
    setAnalysisEdgeIds(null);
    setActiveHotPath(null);
    setActiveInsightId(null);
  }, []);

  const handleFocus = useCallback((id: string | null): void => {
    setFocusId(id);
  }, []);

  const handleDrill = useCallback(
    (systemId: string): void => {
      if (!systemId) return;
      if (drillSystemId === systemId) {
        setDrillSystemId(null);
        return;
      }
      const ids = graph?.nodes.filter((node) => node.appSystemId === systemId).map((node) => node.id) ?? [];
      setViewMode('host');
      setDrillSystemId(systemId);
      setSelectedId(null);
      setFocusId(null);
      setAnalysisNodeIds(null);
      setAnalysisEdgeIds(null);
      setActiveHotPath(null);
      setActiveInsightId(null);
      centerOn(ids);
    },
    [centerOn, drillSystemId, graph],
  );

  const switchView = useCallback(
    (mode: TopoViewMode): void => {
      setViewMode(mode);
      setDrillSystemId(null);
      setSelectedId(null);
      setFocusId(null);
      setAnalysisNodeIds(null);
      setAnalysisEdgeIds(null);
      setActiveHotPath(null);
      setActiveInsightId(null);
    },
    [],
  );

  const loadHistory = useCallback(
    async (id: string): Promise<void> => {
      if (!id) return;
      setHistoryId(id);
      if (demo) {
        const next = denseCase && id === DEMO_DENSE_GRAPH.id ? DEMO_DENSE_GRAPH : demoGraphById(id);
        setGraph(next ? filterGraphByScope(next, scopeId || null) : null);
        return;
      }
      setLoading(true);
      try {
        const next = await getTopologyGraph(id);
        setGraph(filterGraphByScope(next, scopeId || null));
      } catch {
        showToast('error', '加载历史版本失败，请重试。');
      } finally {
        setLoading(false);
      }
    },
    [denseCase, demo, scopeId, showToast],
  );

  const back = onBack ?? ((): void => {
    window.location.href = window.location.pathname;
  });

  const openAgents = useCallback((): void => {
    if (demo) {
      showToast('ok', '演示模式：已模拟跳转到操作系统智能体');
      return;
    }
    window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'agents' }));
  }, [demo, showToast]);

  const locateSearch = useCallback((): void => {
    if (!layout) return;
    const matches = [...matchNodeIds(layout, search)];
    if (matches.length === 0) return;
    centerOn(matches.slice(0, 4));
  }, [centerOn, layout, search]);

  const running = session !== null && RUNNING_STATUS.has(session.status);
  const stats = graph?.stats;
  const failedEdges = layout?.anomalies ?? 0;
  const scopeOptions = appSystems;
  const scopeName = scopeId ? scopeOptions.find((system) => system.id === scopeId)?.name ?? '应用系统' : '全部应用系统';

  return (
    <div className={`app topo-shell${fullscreen ? ' topo-fullscreen' : ''}`}>
      <AppSidebar active="topology" onHome={back} />
      <section className="main">
        <header className="topbar">
          <div className="crumbs">
            <button type="button" className="crumbs-link" onClick={back}>
              工作台
            </button>
            <span className="sep">/</span>
            <span className="current">访问拓扑</span>
            {demo ? <span className="topo-demo-pill">DEMO</span> : null}
          </div>
          <div className="topbar-spacer" />
          <span className="env-pill">
            <span className="dot dot-ok" style={{ width: 5, height: 5 }} />
            {demo ? '演示数据' : '本地开发'}
          </span>
          <ThemeToggle />
        </header>

        <div className="topo-page">
          <div className="topo-head">
            <div className="topo-head-copy">
              <div className="eyebrow">TOPOLOGY · 真实建连关系学习</div>
              <h1>业务访问拓扑</h1>
              <p className="sub">
                大模型基于 Agent 采集的监听端口、进程与建连证据识别组件与 IT 分层，生成业务系统泳道、跨系统访问与风险洞察。
                <span className="topo-head-scope">当前范围：{scopeName}</span>
              </p>
            </div>
            <div className="topo-head-actions">
              <button
                type="button"
                className={`topo-auto${policy?.enabled ? ' is-on' : ''}`}
                onClick={() => setPolicyOpen(true)}
                title="自动学习策略"
              >
                <span className={`switch${policy?.enabled ? ' is-on' : ''}`} aria-hidden="true" />
                <span className="topo-auto-copy">
                  <strong>自动学习</strong>
                  <em>
                    {policy
                      ? `${intervalLabel(policy.intervalSeconds)} · ${policy.nextRunAt ? `下次 ${timeOf(policy.nextRunAt)}` : '未排期'}`
                      : '未配置策略'}
                  </em>
                </span>
              </button>
              <button
                type="button"
                className="btn btn-outline topo-btn-auto"
                onClick={() => {
                  setWizardOpen(true);
                  setWizardError(null);
                }}
              >
                <MiniIcon name="spark" size={14} /> 学习向导
                {running ? <span className="topo-running-dot" /> : null}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setWizardOpen(true);
                  setSession(null);
                  setWizardError(null);
                  finishedSessionRef.current = null;
                }}
              >
                <MiniIcon name="play" size={13} /> 开始学习
              </button>
            </div>
          </div>

          {loading ? (
            <div className="topo-stage topo-stage-skeleton" aria-busy="true">
              <div className="topo-skeleton-bar" />
              <div className="topo-skeleton-canvas">
                <div className="topo-skeleton-node" />
                <div className="topo-skeleton-node" />
                <div className="topo-skeleton-node" />
                <div className="topo-skeleton-node" />
                <div className="topo-skeleton-node" />
              </div>
            </div>
          ) : loadError ? (
            <div className="topo-stage topo-stage-message">
              <div className="topo-message-card">
                <span className={`topo-message-icon is-${loadError.kind === 'unauthorized' ? 'warn' : 'danger'}`}>
                  <MiniIcon name="warning" size={20} />
                </span>
                <h2>{loadError.kind === 'unauthorized' ? '登录状态已失效' : '拓扑服务暂不可用'}</h2>
                <p>{loadError.message}</p>
                <div className="topo-message-actions">
                  {loadError.kind === 'unauthorized' ? (
                    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                      重新登录
                    </button>
                  ) : (
                    <>
                      <button type="button" className="btn btn-outline" onClick={() => void loadTopology()}>
                        <MiniIcon name="refresh" size={14} /> 重新加载
                      </button>
                      <button type="button" className="btn btn-primary" onClick={() => setWizardOpen(true)}>
                        <MiniIcon name="play" size={13} /> 先运行一次学习
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : !graph || !layout || !view ? (
            <div className="topo-stage topo-stage-empty">
              <div className="topo-empty">
                <div className="topo-empty-visual" aria-hidden="true">
                  <svg className="topo-empty-svg" viewBox="0 0 520 220" width="100%" height="100%" role="img" aria-label="拓扑空态示意">
                    <defs>
                      <linearGradient id="empty-flow" x1="0" x2="1">
                        <stop offset="0" stopColor="#2c4c7e" />
                        <stop offset="1" stopColor="#4d8dff" />
                      </linearGradient>
                    </defs>
                    <g className="topo-empty-lines" stroke="url(#empty-flow)" strokeWidth="1.6" fill="none">
                      <path d="M112 74 C 170 74, 170 112, 232 112" />
                      <path d="M112 148 C 170 148, 170 112, 232 112" />
                      <path d="M288 112 C 336 112, 336 74, 400 74" />
                      <path d="M288 112 C 336 112, 336 148, 400 148" />
                    </g>
                    <g className="topo-empty-node">
                      <rect x="48" y="46" width="64" height="56" rx="10" />
                      <rect x="48" y="120" width="64" height="56" rx="10" />
                      <rect x="232" y="84" width="56" height="56" rx="10" />
                      <rect x="400" y="46" width="64" height="56" rx="10" />
                      <rect x="400" y="120" width="64" height="56" rx="10" />
                    </g>
                  </svg>
                </div>
                <div className="eyebrow">NO TOPOLOGY YET · 还没有拓扑版本</div>
                <h2>从采集到生成，三步得到第一版业务访问拓扑</h2>
                <div className="topo-empty-steps">
                  <div className="topo-empty-step">
                    <span className="topo-step-index">01</span>
                    <strong>采集</strong>
                    <p>纳管主机上的 Agent 按 10s 窗口上报真实建连边，含进程、端口与失败次数。</p>
                  </div>
                  <div className="topo-empty-step">
                    <span className="topo-step-index">02</span>
                    <strong>学习</strong>
                    <p>固定时间窗内聚合去重，归因到主机与应用系统，形成跨系统访问关系。</p>
                  </div>
                  <div className="topo-empty-step">
                    <span className="topo-step-index">03</span>
                    <strong>生成</strong>
                    <p>大模型识别组件与 IT 分层，输出核心链路与风险；模型不可用时由规则引擎兜底。</p>
                  </div>
                </div>
                <button type="button" className="btn btn-primary" onClick={() => setWizardOpen(true)}>
                  <MiniIcon name="play" size={14} /> 开始一次学习
                </button>
              </div>
            </div>
          ) : (
            <div className="topo-body">
              <section className="topo-stage" aria-label="业务访问拓扑画布">
                <div className="topo-toolbar">
                  <div className="topo-toolbar-left">
                    <label className="topo-select-wrap">
                      <span className="topo-select-label">范围</span>
                      <select
                        className="select topo-select"
                        value={scopeId}
                        onChange={(event) => {
                          setScopeId(event.target.value);
                          setHistoryId('');
                        }}
                      >
                        <option value="">全部应用系统</option>
                        {scopeOptions.map((system) => (
                          <option key={system.id} value={system.id}>
                            {system.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="segmented topo-view-switch" role="group" aria-label="视图切换">
                      <button
                        type="button"
                        className={viewMode === 'host' ? 'is-on' : ''}
                        onClick={() => switchView('host')}
                      >
                        主机视图
                      </button>
                      <button
                        type="button"
                        className={viewMode === 'system' ? 'is-on' : ''}
                        onClick={() => switchView('system')}
                      >
                        业务系统视图
                      </button>
                    </div>
                    <label className="topo-select-wrap">
                      <span className="topo-select-label">版本</span>
                      <select
                        className="select topo-select topo-select-history"
                        value={historyId}
                        onChange={(event) => void loadHistory(event.target.value)}
                        disabled={graphList.length === 0}
                      >
                        {graphList.length === 0 ? <option value="">暂无历史版本</option> : null}
                        {graphList.map((item) => (
                          <option key={item.id} value={item.id}>
                            v{item.version} · {timeOf(item.createdAt)} · {item.nodeCount} 节点 / {item.edgeCount} 链路
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="topo-toolbar-right">
                    <div className="topo-search">
                      <MiniIcon name="search" size={14} />
                      <input
                        className="topo-search-input"
                        value={search}
                        placeholder="搜索主机 / IP / 服务端口"
                        onChange={(event) => setSearch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') locateSearch();
                        }}
                        aria-label="搜索拓扑节点"
                      />
                      {search ? (
                        <>
                          <span className="topo-search-count">{matchCount}</span>
                          <button type="button" className="topo-search-clear" aria-label="清除搜索" onClick={() => setSearch('')}>
                            <MiniIcon name="close" size={12} />
                          </button>
                        </>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className={`topo-filter${filterAnomaly ? ' is-on' : ''}`}
                      onClick={() => setFilterAnomaly((current) => !current)}
                      aria-pressed={filterAnomaly}
                    >
                      <MiniIcon name="alert" size={13} /> 异常链路
                      <em>{failedEdges}</em>
                    </button>
                    <button
                      type="button"
                      className={`topo-filter${filterCross ? ' is-on' : ''}`}
                      onClick={() => setFilterCross((current) => !current)}
                      aria-pressed={filterCross}
                    >
                      <MiniIcon name="link" size={13} /> 跨系统
                      <em>{layout.edges.filter((edge) => edge.crossSystem).length}</em>
                    </button>
                    <button
                      type="button"
                      className={`topo-filter${showUnassigned ? ' is-on' : ''}`}
                      onClick={() => setShowUnassigned((current) => !current)}
                      aria-pressed={showUnassigned}
                      title={`默认隐藏不属于任何应用系统的主机；本次学习服务端已排除 ${
                        graph.stats.excludedUnassigned ?? 0
                      } 台未归属主机`}
                    >
                      <MiniIcon name="layers" size={13} /> 未归属主机
                      <em>
                        {showUnassigned
                          ? view.nodes.filter(
                              (item) => !item.aggregated && !item.node.appSystemId && item.node.kind !== 'external',
                            ).length
                          : view.hiddenUnassigned}
                        {(graph.stats.excludedUnassigned ?? 0) > 0
                          ? `（已排除 ${graph.stats.excludedUnassigned}）`
                          : ''}
                      </em>
                    </button>
                    <button
                      type="button"
                      className={`topo-filter${settingsOpen ? ' is-on' : ''}`}
                      onClick={() => setSettingsOpen((current) => !current)}
                      aria-expanded={settingsOpen}
                      aria-haspopup="dialog"
                    >
                      <MiniIcon name="filter" size={13} /> 显示设置
                    </button>
                    <button
                      type="button"
                      className={`topo-filter${railOpen ? ' is-on' : ''}`}
                      onClick={() => setRailOpen((current) => !current)}
                      aria-pressed={railOpen}
                      title="显示/隐藏右侧分析抽屉"
                    >
                      <MiniIcon name="layers" size={13} /> 分析
                    </button>
                    <button
                      type="button"
                      className={`topo-filter${fullscreen ? ' is-on' : ''}`}
                      onClick={() => {
                        setFullscreen((current) => {
                          if (!current) setRailOpen(false);
                          return !current;
                        });
                        setFitEpoch((current) => current + 1);
                      }}
                      aria-pressed={fullscreen}
                      title={fullscreen ? '退出全屏（Esc）' : '页面内全屏查看拓扑'}
                    >
                      <MiniIcon name="fit" size={13} /> {fullscreen ? '退出全屏' : '全屏'}
                    </button>
                  </div>
                </div>

                {settingsOpen ? (
                  <div className="topo-settings-pop" role="dialog" aria-label="显示设置">
                    <div className="topo-settings-head">
                      <strong>显示设置</strong>
                      <button type="button" className="topo-icon-btn" aria-label="关闭显示设置" onClick={() => setSettingsOpen(false)}>
                        <MiniIcon name="close" size={13} />
                      </button>
                    </div>
                    <div className="topo-settings-row">
                      <div>
                        <strong>边标签</strong>
                        <span>默认只在悬停/选中边时显示完整标签</span>
                      </div>
                      <button
                        type="button"
                        className={`switch topo-switch${displaySettings.edgeLabels ? ' is-on' : ''}`}
                        aria-pressed={displaySettings.edgeLabels}
                        aria-label="显示边标签"
                        onClick={() => setDisplaySettings((current) => ({ ...current, edgeLabels: !current.edgeLabels }))}
                      />
                    </div>
                    <div className="topo-settings-row">
                      <div>
                        <strong>管理流量</strong>
                        <span>SSH / Zabbix / node_exporter / Prometheus / Grafana / Agent</span>
                      </div>
                      <button
                        type="button"
                        className={`switch topo-switch${displaySettings.management ? ' is-on' : ''}`}
                        aria-pressed={displaySettings.management}
                        aria-label="显示管理流量"
                        onClick={() => setDisplaySettings((current) => ({ ...current, management: !current.management }))}
                      />
                    </div>
                    <div className="topo-settings-row">
                      <div>
                        <strong>低流量边</strong>
                        <span>关闭时隐藏占比低于 0.4% 的长尾端口边</span>
                      </div>
                      <button
                        type="button"
                        className={`switch topo-switch${displaySettings.showAllEdges ? ' is-on' : ''}`}
                        aria-pressed={displaySettings.showAllEdges}
                        aria-label="显示全部低流量边"
                        onClick={() => setDisplaySettings((current) => ({ ...current, showAllEdges: !current.showAllEdges }))}
                      />
                    </div>
                    <div className="topo-settings-row">
                      <div>
                        <strong>外部依赖 topN</strong>
                        <span>按连接数保留前 N 个 IP，其余折叠</span>
                      </div>
                      <select
                        className="select topo-settings-select"
                        value={displaySettings.externalTopN}
                        onChange={(event) =>
                          setDisplaySettings((current) => ({ ...current, externalTopN: Number(event.target.value) }))
                        }
                        aria-label="外部依赖 topN"
                      >
                        {[4, 8, 12, 16].map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="topo-settings-row">
                      <div>
                        <strong>紧凑卡片</strong>
                        <span>关闭后最多显示 2 个端口</span>
                      </div>
                      <button
                        type="button"
                        className={`switch topo-switch${displaySettings.compactCards ? ' is-on' : ''}`}
                        aria-pressed={displaySettings.compactCards}
                        aria-label="紧凑卡片"
                        onClick={() => setDisplaySettings((current) => ({ ...current, compactCards: !current.compactCards }))}
                      />
                    </div>
                    <div className="topo-settings-foot">
                      <span>
                        原始 {prepared?.stats.originalEdgeCount ?? 0} 条边 · 当前 {layout?.edges.length ?? 0} 条
                      </span>
                      <span>
                        已过滤 SSH/管理 {prepared?.stats.hiddenManagement ?? 0} · 低流量 {prepared?.stats.hiddenLowTraffic ?? 0}
                      </span>
                    </div>
                  </div>
                ) : null}

                <div className="topo-statbar">
                  {systemViewStats ? (
                    <>
                      <span className="topo-statbar-item">
                        业务系统 <b>{systemViewStats.systems}</b>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item">
                        系统间链路 <b>{systemViewStats.edges}</b>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item">
                        连接 <b>{(systemViewStats.connections / 1000).toFixed(1)}k</b>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item is-danger">
                        失败连接 <b>{systemViewStats.failed}</b>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item">
                        外部依赖 <b>{systemViewStats.external}</b>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item is-muted">
                        未归属 <b>{systemViewStats.unassigned}</b>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="topo-statbar-item">
                        主机 <b>{prepared?.stats.hostCount ?? 0}</b> · 外部 IP <b>{prepared?.stats.externalIpCount ?? 0}</b>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item">
                        链路 <b>{layout.edges.length}</b>
                        <em className="topo-statbar-note"> / 原始 {prepared?.stats.originalEdgeCount ?? 0}</em>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item">
                        连接 <b>{((prepared?.stats.totalConnections ?? 0) / 1000).toFixed(1)}k</b>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item is-danger">
                        失败连接 <b>{prepared?.stats.failedConnections ?? 0}</b>
                      </span>
                      <span className="topo-statbar-sep" />
                      <span className="topo-statbar-item">
                        业务系统 <b>{hostStats.systems}</b> · 外部依赖 <b>{prepared?.stats.externalIpCount ?? 0} 个 IP</b>
                        <em className="topo-statbar-note">（{prepared?.stats.externalCardCount ?? 0} 组卡片）</em>
                      </span>
                      <span className="topo-statbar-sep is-optional" />
                      <span className="topo-statbar-item is-optional is-muted">
                        已过滤 管理 {prepared?.stats.hiddenManagement ?? 0} · 低流量 {prepared?.stats.hiddenLowTraffic ?? 0}
                      </span>
                      <span className="topo-statbar-sep is-optional" />
                      <span className="topo-statbar-item is-optional is-muted">
                        窗口 <b>{Math.round(graph.window.seconds / 60)} 分钟</b> · Agent <b>{stats?.reportingAgents ?? 0}</b>
                      </span>
                    </>
                  )}
                  <span className="topo-statbar-spacer" />
                  <span className="topo-statbar-item is-muted">
                    {systemViewStats ? '系统视图' : '主机视图'} · 窗口 {Math.round(graph.window.seconds / 60)} 分钟 · 生成{' '}
                    {relativeTime(graph.analysis.generatedAt)}
                    {graph.analysis.fallback ? ' · 规则兜底' : ''}
                  </span>
                </div>

                <div className="topo-focusbar">
                  <span className="topo-focusbar-label">
                    <MiniIcon name="target" size={13} /> 画布状态
                  </span>
                  {selectedId ? (
                    <span className="topo-focus-chip is-node">
                      {layout.nodeById.get(selectedId)?.node.label ?? selectedId}
                      <button type="button" aria-label="取消选中" onClick={() => setSelectedId(null)}>
                        <MiniIcon name="close" size={11} />
                      </button>
                    </span>
                  ) : null}
                  {focusId ? (
                    <span className="topo-focus-chip is-focus">
                      <MiniIcon name="pin" size={11} /> 聚焦 {layout.nodeById.get(focusId)?.node.label ?? focusId} 的上下游
                      <button type="button" aria-label="退出聚焦" onClick={() => setFocusId(null)}>
                        <MiniIcon name="close" size={11} />
                      </button>
                    </span>
                  ) : null}
                  {drillSystemId ? (
                    <span className="topo-focus-chip is-focus">
                      <MiniIcon name="layers" size={11} /> 业务系统 {appSystems.find((system) => system.id === drillSystemId)?.name ?? drillSystemId}
                      <button type="button" aria-label="清除业务系统聚焦" onClick={() => setDrillSystemId(null)}>
                        <MiniIcon name="close" size={11} />
                      </button>
                    </span>
                  ) : null}
                  {activeHotPath !== null ? (
                    <span className="topo-focus-chip is-analysis">
                      <MiniIcon name="spark" size={11} /> 核心链路 {graph.analysis.hotPaths[activeHotPath]?.label ?? ''}
                      <button type="button" aria-label="清除分析聚焦" onClick={clearAnalysis}>
                        <MiniIcon name="close" size={11} />
                      </button>
                    </span>
                  ) : null}
                  {activeInsightId ? (
                    <span className="topo-focus-chip is-analysis">
                      <MiniIcon name="alert" size={11} /> 已定位风险：{graph.analysis.insights.find((insight) => insight.id === activeInsightId)?.title ?? graph.analysis.risks.find((risk) => risk.id === activeInsightId)?.title ?? ''}
                      <button type="button" aria-label="清除分析聚焦" onClick={clearAnalysis}>
                        <MiniIcon name="close" size={11} />
                      </button>
                    </span>
                  ) : null}
                  {search.trim() ? (
                    <span className="topo-focus-chip">
                      <MiniIcon name="search" size={11} /> “{search.trim()}” 命中 {matchCount} 个节点
                      <button type="button" aria-label="清除搜索" onClick={() => setSearch('')}>
                        <MiniIcon name="close" size={11} />
                      </button>
                    </span>
                  ) : null}
                  {filterAnomaly || filterCross ? (
                    <span className="topo-focus-chip is-warn">
                      <MiniIcon name="filter" size={11} /> 已筛选
                      {filterAnomaly ? ' 异常链路' : ''}
                      {filterAnomaly && filterCross ? ' +' : ''}
                      {filterCross ? ' 跨系统' : ''}
                      <button
                        type="button"
                        aria-label="清除筛选"
                        onClick={() => {
                          setFilterAnomaly(false);
                          setFilterCross(false);
                        }}
                      >
                        <MiniIcon name="close" size={11} />
                      </button>
                    </span>
                  ) : null}
                  <span className="topo-focusbar-spacer" />
                  {selectedId ? (
                    <button
                      type="button"
                      className={`topo-focusbar-link${keepFullView ? ' is-on' : ''}`}
                      onClick={() => setKeepFullView((current) => !current)}
                      title="开启后点击节点不再自动缩放到 ego network"
                    >
                      {keepFullView ? '已保持全图' : '保持全图'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="topo-focusbar-link"
                    onClick={() => {
                      setSelectedId(null);
                      setFocusId(null);
                      setFitEpoch((current) => current + 1);
                    }}
                  >
                    返回全图
                  </button>
                  <button
                    type="button"
                    className="topo-focusbar-link"
                    onClick={() => {
                      setSelectedId(null);
                      setFocusId(null);
                      setDrillSystemId(null);
                      setSearch('');
                      setFilterAnomaly(false);
                      setFilterCross(false);
                      clearAnalysis();
                    }}
                  >
                    重置画布状态
                  </button>
                </div>

                <TopologyCanvas
                  view={view}
                  layout={layout}
                  selectedId={selectedId}
                  focusId={focusId}
                  analysisNodeIds={analysisNodeIds}
                  analysisEdgeIds={analysisEdgeIds}
                  drillSystemId={drillSystemId}
                  search={search}
                  filterAnomaly={filterAnomaly}
                  filterCross={filterCross}
                  centerTarget={centerTarget}
                  showEdgeLabels={displaySettings.edgeLabels}
                  fitEpoch={fitEpoch}
                  onSelect={handleSelect}
                  onFocus={handleFocus}
                  onDrill={handleDrill}
                  onHoverNode={() => undefined}
                />

                <footer className="topo-stage-foot">
                  <div className="topo-legend-row">
                    <div className="topo-legend-group">
                      {layout.columns.map((column) => (
                        <span key={column.id} className="topo-legend-item">
                          <i style={{ background: column.accent }} /> {column.title}
                          <em>{column.count}</em>
                        </span>
                      ))}
                    </div>
                    <div className="topo-legend-group">
                      {layout.systemLegend.filter((system) => system.nodeCount > 0).map((system) => (
                        <span key={system.id} className="topo-legend-item">
                          <i style={{ background: system.color }} /> {system.name}
                          <em>{system.nodeCount}</em>
                        </span>
                      ))}
                      <span className="topo-legend-item">
                        <i className="is-external" /> 外部依赖
                      </span>
                    </div>
                    <div className="topo-legend-group is-semantics">
                      <span className="topo-legend-item">
                        <i className="topo-legend-line is-normal" /> 普通
                      </span>
                      <span className="topo-legend-item">
                        <i className="topo-legend-line is-hot" /> 高频流动
                      </span>
                      <span className="topo-legend-item">
                        <i className="topo-legend-line is-bad" /> 失败链路
                      </span>
                      <span className="topo-legend-item">
                        <i className="topo-legend-line is-cross" /> 跨系统
                      </span>
                    </div>
                  </div>
                  <div className="topo-legend-links">
                    <span className="topo-legend-links-label">关键链路</span>
                    {topLinks.map((edge) => (
                      <button
                        key={edge.edge.id}
                        type="button"
                        className="topo-link-chip"
                        title={edge.fullLabel}
                        onClick={() => focusEdgeGroup([edge.edge.id], [edge.sourceId, edge.targetId])}
                      >
                        <span className="mono">{truncateText(edge.fullLabel, 118, 11)}</span>
                        {viewMode === 'host' ? <em>{edge.edge.count.toLocaleString('zh-CN')}</em> : null}
                      </button>
                    ))}
                    {layout.edges.length > topLinks.length ? (
                      <span className="topo-link-chip is-more">共 {layout.edges.length} 条链路</span>
                    ) : null}
                  </div>
                </footer>
              </section>

              <aside className={`topo-rail${railOpen ? '' : ' is-collapsed'}`} aria-label="分析面板">
                {selectedNode ? (
                  <NodeDetailPanel
                    node={selectedNode}
                    view={view}
                    graph={prepared?.graph ?? graph}
                    systemColors={systemColors}
                    services={selectedNodeServices}
                    relatedNodes={relatedNodes}
                    externalGroup={externalGroup}
                    keepFullView={keepFullView}
                    onClose={() => {
                      setSelectedId(null);
                      setFocusId(null);
                    }}
                    onFocus={() => setFocusId(selectedNode.id)}
                    onNavigate={(id) => {
                      setSelectedId(id);
                      setFocusId(id);
                    }}
                    onToggleKeepFullView={() => setKeepFullView((current) => !current)}
                    onReturnFull={() => {
                      setSelectedId(null);
                      setFocusId(null);
                      setFitEpoch((current) => current + 1);
                    }}
                    onFullscreen={() => {
                      setFullscreen(true);
                      setFitEpoch((current) => current + 1);
                    }}
                    onOpenAgent={openAgents}
                  />
                ) : (
                  <AnalysisPanel
                    graph={graph}
                    activeHotPath={activeHotPath}
                    activeInsightId={activeInsightId}
                    onHotPath={focusHotPath}
                    onInsight={focusInsight}
                    onClear={clearAnalysis}
                    onOpenModels={() => {
                      if (demo) {
                        showToast('ok', '演示模式：已模拟跳转到模型配置');
                        return;
                      }
                      window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'models' }));
                    }}
                  />
                )}
              </aside>
            </div>
          )}
        </div>
      </section>

      <LearningWizard
        open={wizardOpen}
        appSystems={appSystems}
        defaultAppSystemId={scopeId}
        busy={busy}
        session={session}
        graphVersion={graph?.version ?? null}
        modelAvailable={demo ? true : modelAvailable}
        error={wizardError}
        onStart={(input) => void startLearning(input)}
        onCancel={() => void cancelLearning()}
        onRetry={() => void retryLearning()}
        onClose={() => {
          setWizardOpen(false);
          setWizardError(null);
          if (session && !RUNNING_STATUS.has(session.status)) setSession(null);
        }}
      />

      <PolicyPanel
        open={policyOpen}
        policy={policy}
        appSystems={appSystems}
        saving={policySaving}
        error={policyError}
        onSave={(input) => void savePolicy(input)}
        onClose={() => {
          setPolicyOpen(false);
          setPolicyError(null);
        }}
      />

      {toast ? (
        <div className={`topo-toast is-${toast.kind}`} role="status">
          <span className="topo-toast-dot" />
          {toast.text}
          <button type="button" className="topo-toast-close" aria-label="关闭提示" onClick={() => setToast(null)}>
            <MiniIcon name="close" size={12} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
