import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  assignAgentAppSystem,
  cancelAgentInstruction,
  createAgentCommand,
  createAppSystem,
  createAgentInstruction,
  createAgentInstructionsBatch,
  createAgentInstructionTemplate,
  deleteAgentInstructionTemplate,
  getAgentDetail,
  getAgentInventory,
  updateAgentInventory,
  deleteAgentInventory,
  promoteAgentInventory,
  getAgentEvents,
  getAgentFleet,
  getAgentInstallCommand,
  getAgentPatrolPolicy,
  updateAgentPatrolPolicy,
  getAgentInstruction,
  getAppSystemHealth,
  getAppSystemAccessTopology,
  type AppSystemAccessTopology,
  type AgentPatrolPolicy,
  getCommandKeyStatus,
  listAgentCommands,
  listAgentInstructionTemplates,
  listAgentInstructions,
  updateAgentInstructionTemplate,
  type AgentApplication,
  type AgentCommandSummary,
  type AgentEventSummary,
  type AgentFleetResponse,
  type AgentInstructionDetail,
  type AgentInventoryItem,
  type AgentInstructionTemplate,
  type AgentSummary,
  type AppHealthCheck,
  type CommandKeyStatus,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { relativeTime } from '../format.js';
import { newId } from '../ids.js';

export interface AgentsProps {
  readonly onBack: () => void;
}

type DetailTab = 'overview' | 'system' | 'apps' | 'agent' | 'commands' | 'instruction' | 'alerts';

const SYSTEM_LABELS: Record<string, string> = {
  hostname: '主机名',
  ip: '主 IP',
  ipAddresses: 'IP 地址',
  osName: '操作系统',
  osVersion: '系统版本',
  osPretty: '发行版',
  kernel: '内核',
  virtualization: '虚拟化',
  cpuCores: 'CPU 核数',
  memoryTotalGB: '内存总量',
  diskTotalGB: '磁盘总量',
  diskFreeGB: '磁盘可用',
  uptimeSec: '主机运行时长',
  bootTime: '启动时间',
  timezone: '时区',
  packageManager: '包管理器',
  listeningPorts: '监听端口',
};

const AGENT_LABELS: Record<string, string> = {
  version: 'Agent 版本',
  installPath: '安装路径',
  serviceName: '服务名',
  serviceStatus: '服务状态',
  configPath: '配置文件',
  controlURL: '控制面',
  startedAt: '启动时间',
  capabilities: '能力',
};

const BUILTIN_INSTRUCTION_TEMPLATES = [
  { name: '运行时长与负载', instruction: '系统运行多久了？当前负载和进程数是多少？' },
  { name: '磁盘巡检', instruction: '检查磁盘分区、使用率和可用空间。' },
  { name: '服务与端口', instruction: '检查运行中的服务、监听端口和异常进程。' },
  { name: '日志异常', instruction: '检查最近的系统日志和应用日志异常。' },
  { name: '应用系统健康', instruction: '检查当前应用系统健康情况和跨节点异常。' },
];

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function number(value: unknown, digits = 0): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
}

function statusLabel(status: string): string {
  return status === 'online' ? '在线' : '离线';
}

function criticalityClass(criticality: string): string {
  return criticality === 'P0' || criticality === 'P1' ? 'badge-warn' : 'badge-neutral';
}

function appPorts(application: AgentApplication): string {
  if (!application.ports) return '—';
  return text(application.ports);
}

function AppSystemAccessPanel({ topology, loading, onDrill, onClose }: { topology: AppSystemAccessTopology | null; loading: boolean; onDrill: (id: string) => void; onClose: () => void }) {
  const [zoom, setZoom] = useState(1.12);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);
  if (loading) return <section className="app-access-panel"><div className="app-access-loading">正在加载应用系统访问关系…</div></section>;
  if (!topology) return null;
  const edges = topology.edges.slice(0, 24);
  const anomalies = new Map(topology.nodes.map((node) => [node.hostname, node.anomalies]));
  const nodeInfo = new Map(topology.nodes.map((node) => [node.hostname, node]));
  const sources = new Map<string, { host: string; service: string }>();
  const targets = new Map<string, { host: string; service: string; port: number }>();
  for (const edge of edges) {
    sources.set(`${edge.fromHost}|${edge.fromService}`, { host: edge.fromHost, service: edge.fromService });
    targets.set(`${edge.toHost}|${edge.toService}|${edge.toPort}`, { host: edge.toHost, service: edge.toService, port: edge.toPort });
  }
  const sourceList = [...sources.values()];
  const targetList = [...targets.values()];
  const height = Math.max(220, Math.max(sourceList.length, targetList.length) * 58 + 42);
  const sourceY = (index: number) => 32 + index * 58;
  const targetY = (index: number) => 32 + index * 58;
  const showTip = (event: ReactMouseEvent, title: string, lines: string[]) => {
    setTip({ x: event.clientX, y: event.clientY, title, lines });
  };
  const moveTip = (event: ReactMouseEvent) => {
    setTip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
  };
  const closeTip = () => setTip(null);
  return (
    <section className="app-access-panel">
      <div className="section-heading">
        <div><div className="eyebrow">Application system access</div><h2>{topology.system.name} · 访问关系</h2></div>
        <div className="row-sm"><span className="badge badge-neutral">{topology.nodes.length} 节点 · {edges.length} 条服务访问</span><button type="button" className="btn btn-outline btn-sm" onClick={onClose}>收起</button></div>
      </div>
      {edges.length === 0 ? <div className="app-access-empty">尚未采集到该应用系统内部的服务访问关系。Agent 上报 netstat 后会自动生成。</div> : (
        <div className="app-access-grid">
          <div className="app-topology-canvas">
            <div className="app-topology-toolbar">
              <span>服务级聚合 · 悬浮节点或连接查看详情</span>
              <div className="app-topology-zoom">
                <button type="button" aria-label="缩小" onClick={() => setZoom((current) => Math.max(0.8, Number((current - 0.15).toFixed(2))))}>−</button>
                <span>{Math.round(zoom * 100)}%</span>
                <button type="button" aria-label="放大" onClick={() => setZoom((current) => Math.min(2.4, Number((current + 0.15).toFixed(2))))}>+</button>
                <button type="button" onClick={() => setZoom(1.12)}>重置</button>
              </div>
            </div>
            <div className="app-topology-viewport">
              <div className="app-topology-zoom-canvas" style={{ width: `${zoom * 100}%` }}>
                <svg viewBox={`0 0 980 ${height}`} role="img" aria-label={`${topology.system.name} 内部访问关系`}>
                  <defs><marker id="app-access-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#1769aa"/></marker></defs>
                  <text x="16" y="19" className="app-access-column-label">源服务</text>
                  <text x="664" y="19" className="app-access-column-label">目标服务 / 端口</text>
                  {edges.map((edge, index) => {
                    const sourceIndex = sourceList.findIndex((item) => item.host === edge.fromHost && item.service === edge.fromService);
                    const targetIndex = targetList.findIndex((item) => item.host === edge.toHost && item.service === edge.toService && item.port === edge.toPort);
                    if (sourceIndex < 0 || targetIndex < 0) return null;
                    const y1 = sourceY(sourceIndex) + 26;
                    const y2 = targetY(targetIndex) + 26;
                    const mid = 490;
                    return <g key={`${edge.fromHost}-${edge.fromService}-${edge.toHost}-${edge.toService}-${edge.toPort}-${index}`} onMouseEnter={(event) => showTip(event, '服务访问', [`${edge.fromHost} / ${edge.fromService}`, `→ ${edge.toHost} / ${edge.toService}:${edge.toPort}`, `TCP ESTAB · ${edge.count} 条聚合连接`])} onMouseMove={moveTip} onMouseLeave={closeTip}>
                      <path d={`M316 ${y1} C430 ${y1}, 548 ${y2}, 664 ${y2}`} fill="none" stroke="#1769aa" strokeWidth="2" strokeOpacity=".7" markerEnd="url(#app-access-arrow)" />
                      <path d={`M316 ${y1} C430 ${y1}, 548 ${y2}, 664 ${y2}`} fill="none" stroke="transparent" strokeWidth="14" style={{ cursor: 'help' }} />
                      <text x={mid} y={(y1 + y2) / 2 - 5} textAnchor="middle" className="app-access-edge-label">{edge.fromService} → {edge.toService}:{edge.toPort} · {edge.count}</text>
                    </g>;
                  })}
                  {sourceList.map((item, index) => {
                    const info = nodeInfo.get(item.host);
                    const nodeAlerts = anomalies.get(item.host) ?? [];
                    const alert = nodeAlerts.length > 0;
                    const y = sourceY(index);
                    return <g key={`s-${item.host}-${item.service}`} onMouseEnter={(event) => showTip(event, `${item.host} / ${item.service}`, [`角色：源服务`, info?.ip ? `IP：${info.ip}` : 'IP：未采集', ...(info?.services.filter((service) => service.name === item.service).flatMap((service) => service.ports.map((port) => `监听端口：${port}`)) ?? []), ...(alert ? [`告警：${nodeAlerts[0]}`] : ['状态：无告警'])])} onMouseMove={moveTip} onMouseLeave={closeTip}>
                      <rect x="16" y={y} width="300" height="52" rx="6" fill={alert ? '#fff5f4' : '#fff'} stroke={alert ? '#b43a35' : '#d4e0eb'} strokeWidth={alert ? '1.5' : '1'} />
                      <rect x="16" y={y} width="3" height="52" rx="1.5" fill={alert ? '#b43a35' : '#1769aa'} />
                      <text x="30" y={y + 20} className="app-access-node-title">{item.host}</text>
                      <text x="30" y={y + 38} className="app-access-node-sub">{item.service}</text>
                      {alert ? <text x="302" y={y + 20} textAnchor="end" className="app-access-node-alert">告警</text> : null}
                    </g>;
                  })}
                  {targetList.map((item, index) => {
                    const info = nodeInfo.get(item.host);
                    const nodeAlerts = anomalies.get(item.host) ?? [];
                    const alert = nodeAlerts.length > 0;
                    const y = targetY(index);
                    return <g key={`t-${item.host}-${item.service}-${item.port}`} onMouseEnter={(event) => showTip(event, `${item.host} / ${item.service}:${item.port}`, [`角色：目标服务`, info?.ip ? `IP：${info.ip}` : 'IP：未采集', `监听端口：${item.port}`, `服务：${item.service}`, ...(alert ? [`告警：${nodeAlerts[0]}`] : ['状态：无告警'])])} onMouseMove={moveTip} onMouseLeave={closeTip}>
                      <rect x="664" y={y} width="300" height="52" rx="6" fill={alert ? '#fff5f4' : '#fff'} stroke={alert ? '#b43a35' : '#d4e0eb'} strokeWidth={alert ? '1.5' : '1'} />
                      <rect x="664" y={y} width="3" height="52" rx="1.5" fill={alert ? '#b43a35' : '#2b7256'} />
                      <text x="678" y={y + 20} className="app-access-node-title">{item.host}</text>
                      <text x="678" y={y + 38} className="app-access-node-sub">{item.service} :{item.port}</text>
                      {alert ? <text x="950" y={y + 20} textAnchor="end" className="app-access-node-alert">告警</text> : null}
                    </g>;
                  })}
                </svg>
              </div>
            </div>
            <div className="app-access-legend"><span><i className="blue" />源服务</span><span><i />目标服务:端口</span><span><i className="red" />节点告警</span><span className="app-access-legend-hint">滚轮/缩放查看全图</span></div>
          </div>
          <div className="app-access-side">
            {topology.externalSystems.length === 0 ? <div className="app-access-empty compact">暂无跨应用系统访问。</div> : topology.externalSystems.map((system) => (
              <div key={system.appSystemId} className="app-access-external">
                <div className="app-access-external-head"><div><span className="eyebrow">External system</span><strong>{system.appSystemName}</strong></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => onDrill(system.appSystemId)}>下转查询 →</button></div>
                {system.edges.slice(0, 6).map((edge, index) => (
                  <button key={`${edge.fromHost}-${edge.toHost}-${edge.toPort}-${index}`} type="button" className="app-access-external-row" onClick={() => onDrill(system.appSystemId)}>
                    <span>{edge.fromHost} / {edge.fromService}</span>
                    <span>→</span>
                    <strong>{edge.toService}:{edge.toPort}</strong>
                    <small>{edge.count} 连接</small>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {tip ? <div className="app-access-tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}><strong>{tip.title}</strong>{tip.lines.map((line) => <span key={line}>{line}</span>)}</div> : null}
    </section>
  );
}

export function Agents({ onBack }: AgentsProps) {
  const [fleet, setFleet] = useState<AgentFleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [appSystemId, setAppSystemId] = useState('');
  const [accessTopology, setAccessTopology] = useState<AppSystemAccessTopology | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [os, setOs] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [reloadToken, setReloadToken] = useState(0);
  const [install, setInstall] = useState<{ linux: string; windows: string } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [detailCommands, setDetailCommands] = useState<AgentCommandSummary[]>([]);
  const [detailEvents, setDetailEvents] = useState<AgentEventSummary[]>([]);
  const [inventory, setInventory] = useState<AgentInventoryItem[]>([]);
  const [inventoryFilter, setInventoryFilter] = useState<'all' | 'process' | 'port' | 'service' | 'ops_tool'>('all');
  const [healthChecks, setHealthChecks] = useState<AppHealthCheck[]>([]);
  const [commandBusy, setCommandBusy] = useState(false);
  const [keyStatus, setKeyStatus] = useState<CommandKeyStatus | null>(null);
  const [patrolPolicy, setPatrolPolicy] = useState<AgentPatrolPolicy | null>(null);
  const [patrolBusy, setPatrolBusy] = useState(false);
  const [patrolNote, setPatrolNote] = useState<string | null>(null);
  const [instructionText, setInstructionText] = useState('');
  const [instructionBusy, setInstructionBusy] = useState(false);
  const [instructionNote, setInstructionNote] = useState<string | null>(null);
  const [instructionError, setInstructionError] = useState<string | null>(null);
  const [instructionResult, setInstructionResult] = useState<AgentInstructionDetail | null>(null);
  const [activeInstructionId, setActiveInstructionId] = useState<string | null>(null);
  const [instructionHistory, setInstructionHistory] = useState<AgentInstructionDetail[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [batchText, setBatchText] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<Array<{
    agentId: string;
    hostname: string;
    instructionId: string;
    status: string;
    answer: string;
  }>>([]);
  const [instructionTemplates, setInstructionTemplates] = useState<AgentInstructionTemplate[]>([]);
  const [templateScope, setTemplateScope] = useState<'private' | 'tenant'>('tenant');
  useEffect(() => {
    setInstructionText('');
    setInstructionNote(null);
    setInstructionError(null);
    setInstructionResult(null);
    setInstructionHistory([]);
  }, [detailId]);
  useEffect(() => {
    if (!detailId) return;
    setPatrolPolicy(null);
    setPatrolNote(null);
    void getAgentPatrolPolicy(detailId).then(setPatrolPolicy).catch(() => undefined);
    void getAgentInventory(detailId).then(setInventory).catch(() => setInventory([]));
  }, [detailId]);
  useEffect(() => {
    if (!detailId) return;
    void listAgentInstructions(detailId)
      .then(setInstructionHistory)
      .catch(() => undefined);
  }, [detailId, instructionResult?.status]);
  useEffect(() => {
    void listAgentInstructionTemplates().then(setInstructionTemplates).catch(() => undefined);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void getAppSystemHealth()
        .then((data) => {
          if (!cancelled) setHealthChecks(data);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void getCommandKeyStatus()
        .then((data) => {
          if (!cancelled) setKeyStatus(data);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reloadToken]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void getAgentFleet({ query, status, appSystemId, os, page, pageSize })
        .then((data) => {
          if (!cancelled) setFleet(data);
        })
        .catch(() => {
          if (!cancelled) setError('智能体列表加载失败');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, status, appSystemId, os, page, pageSize, reloadToken]);

  async function openInstall() {
    try {
      const [linux, windows] = await Promise.all([
        getAgentInstallCommand('linux'),
        getAgentInstallCommand('windows'),
      ]);
      setInstall({ linux: linux.command, windows: windows.command });
    } catch {
      setError('安装命令生成失败，请确认 Agent 二进制和 enrollment token 已配置');
    }
  }

  async function refreshDetail(id: string) {
    const [agent, commands, events] = await Promise.all([
      getAgentDetail(id),
      listAgentCommands(id),
      getAgentEvents(id),
    ]);
    setDetail(agent);
    setDetailCommands(commands);
    setDetailEvents(events);
  }

  async function openDetail(id: string) {
    setDetailId(id);
    setDetail(null);
    setDetailTab('overview');
    setDetailLoading(true);
    try {
      await refreshDetail(id);
    } catch {
      setError('智能体详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  }

  async function assignAppSystem(nextId: string) {
    if (!detail) return;
    try {
      const updated = await assignAgentAppSystem(detail.id, nextId || null);
      setDetail(updated);
      setReloadToken((token) => token + 1);
    } catch {
      setError('应用系统归属更新失败');
    }
  }

  async function runCommand(type: 'diagnostics' | 'discovery') {
    if (!detail) return;
    setCommandBusy(true);
    try {
      const command = await createAgentCommand(detail.id, type);
      setDetailCommands((current) => [command, ...current]);
    } catch {
      setError('命令下发失败');
    } finally {
      setCommandBusy(false);
    }
  }

  async function openAppSystemAccess(id: string) {
    setAppSystemId(id);
    setPage(1);
    if (!id) {
      setAccessTopology(null);
      return;
    }
    setAccessLoading(true);
    try {
      setAccessTopology(await getAppSystemAccessTopology(id));
    } catch {
      setError('应用系统访问关系加载失败');
      setAccessTopology(null);
    } finally {
      setAccessLoading(false);
    }
  }

  async function addAppSystem() {
    const name = window.prompt('应用系统名称');
    if (!name?.trim()) return;
    const code = window.prompt('应用系统编码（字母数字和短横线）', `app-${Date.now().toString().slice(-6)}`);
    if (!code?.trim()) return;
    try {
      await createAppSystem({ name: name.trim(), code: code.trim() });
      setReloadToken((value) => value + 1);
    } catch {
      setError('新增应用系统失败，编码可能已存在');
    }
  }

  async function toggleInventory(item: AgentInventoryItem, field: 'important' | 'monitored') {
    if (!detail) return;
    try {
      const updated = await updateAgentInventory(detail.id, item.id, { [field]: !item[field] });
      setInventory((current) => current.map((row) => row.id === updated.id ? updated : row));
    } catch {
      setError('巡检对象更新失败');
    }
  }

  async function removeInventory(item: AgentInventoryItem) {
    if (!detail || !window.confirm(`从当前应用系统隐藏 ${item.name}？其他主机的同名对象也会消失。`)) return;
    try {
      await deleteAgentInventory(detail.id, item.id);
      setInventory(await getAgentInventory(detail.id));
    } catch {
      setError('删除巡检对象失败');
    }
  }

  async function promoteInventory(item: AgentInventoryItem) {
    if (!detail) return;
    try {
      await promoteAgentInventory(detail.id, item.id);
      setInventory(await getAgentInventory(detail.id));
      setInventoryFilter('ops_tool');
    } catch {
      setError('转为运维工具失败');
    }
  }

  function inventoryDetail(item: AgentInventoryItem): string {    const detail = item.detail;
    if (item.kind === 'process') {
      return String(detail.executable ?? detail.installPath ?? detail.command ?? detail.path ?? '—');
    }
    if (item.kind === 'port') {
      return [detail.process, detail.address].filter(Boolean).map(String).join(' · ') || '—';
    }
    if (item.kind === 'service') {
      return [detail.unitPath, ...(Array.isArray(detail.logPaths) ? detail.logPaths : [])].filter(Boolean).slice(0, 2).map(String).join(' · ') || '—';
    }
    return [detail.path, detail.version].filter(Boolean).map(String).join(' · ') || '—';
  }

  async function savePatrolPolicy() {
    if (!detail || !patrolPolicy) return;
    setPatrolBusy(true);
    setPatrolNote(null);
    try {
      const updated = await updateAgentPatrolPolicy(detail.id, {
        enabled: patrolPolicy.enabled,
        intervalSeconds: patrolPolicy.intervalSeconds,
        diskFreePct: patrolPolicy.diskFreePct,
        memLoadPct: patrolPolicy.memLoadPct,
        load1: patrolPolicy.load1,
      });
      setPatrolPolicy(updated);
      setPatrolNote('巡航阈值已保存，Agent 将在 60 秒内同步');
    } catch {
      setPatrolNote('保存失败');
    } finally {
      setPatrolBusy(false);
    }
  }

  async function sendInstruction() {
    if (!detail || !instructionText.trim()) return;
    setInstructionBusy(true);
    setInstructionError(null);
    setInstructionResult(null);
    try {
      const created = await createAgentInstruction(
        detail.id,
        instructionText.trim(),
        newId(),
      );
      setActiveInstructionId(created.instructionId ?? null);
      setInstructionNote(
        `已下发给 ${created.hostname}：${created.intent.kind} / ${created.status}`,
      );
      if (created.approvalId || !created.instructionId || !created.commandId) {
        setInstructionNote(`写操作已提交审批（${created.approvalId ?? '待处理'}），批准后执行`);
        return;
      }
      const instructionId = created.instructionId;
      const commandId = created.commandId;
      let latest: AgentInstructionDetail | null = null;
      if (typeof EventSource !== 'undefined' && !(window as unknown as { __OPSAGENT_TEST__?: boolean }).__OPSAGENT_TEST__) {
        latest = await new Promise<AgentInstructionDetail | null>((resolve) => {
          const source = new EventSource(
            `/api/agents/${detail.id}/instructions/${instructionId}/events`,
            { withCredentials: true },
          );
          const timer = window.setTimeout(() => {
            source.close();
            resolve(null);
          }, 8000);
          const finish = (value: AgentInstructionDetail | null): void => {
            window.clearTimeout(timer);
            source.close();
            resolve(value);
          };
          source.addEventListener('open', () => {
            setInstructionResult((current) => current ? { ...current, answer: '' } : current);
          });
          source.addEventListener('status', (event) => {
            const data = JSON.parse((event as MessageEvent).data) as { status: string };
            setInstructionNote(`指令状态：${data.status}`);
          });
          source.addEventListener('delta', (event) => {
            const data = JSON.parse((event as MessageEvent).data) as { text: string };
            setInstructionResult((current) => current
              ? { ...current, answer: current.answer + data.text, status: 'running' }
              : {
                  instructionId,
                  commandId,
                  status: 'running',
                  instruction: instructionText.trim(),
                  intent: created.intent,
                  answer: data.text,
                  evidence: null,
                  toolsUsed: null,
                  createdAt: new Date().toISOString(),
                  completedAt: null,
                });
          });
          source.addEventListener('done', (event) => {
            finish(JSON.parse((event as MessageEvent).data) as AgentInstructionDetail);
          });
          source.addEventListener('error', (event) => {
            const data = (event as MessageEvent).data;
            if (typeof data === 'string' && data) {
              finish(null);
              return;
            }
            // Let EventSource reconnect with Last-Event-ID; the 8s timer falls back to polling.
          });
        });
      }
      if (!latest) {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          latest = await getAgentInstruction(detail.id, instructionId);
          if (['completed', 'failed', 'canceled', 'expired'].includes(latest.status)) break;
        }
      }
      setInstructionResult(latest);
      setInstructionNote(latest ? `指令状态：${latest.status}` : null);
    } catch (caught) {
      setInstructionError(caught instanceof Error ? caught.message : '指令下发失败');
    } finally {
      setInstructionBusy(false);
      setActiveInstructionId(null);
    }
  }

  async function cancelInstruction() {
    if (!detail || !activeInstructionId) return;
    try {
      await cancelAgentInstruction(detail.id, activeInstructionId);
      setInstructionNote('指令已取消');
      setActiveInstructionId(null);
    } catch {
      setInstructionError('指令取消失败');
    }
  }

  async function sendBatchInstruction() {
    if (batchIds.length === 0 || !batchText.trim()) return;
    setBatchBusy(true);
    setBatchNote(null);
    try {
      const created = await createAgentInstructionsBatch(batchIds, batchText.trim());
      if (created.approvals) {
        setBatchResults(created.approvals.map((item) => ({
          agentId: item.agentId,
          hostname: item.hostname,
          instructionId: item.approvalId,
          status: 'awaiting_approval',
          answer: '等待审批',
        })));
        setBatchNote(`已提交 ${created.approvals.length} 个写操作审批`);
        setBatchIds([]);
        setBatchText('');
        return;
      }
      const initial = (created.instructions ?? []).map((item) => ({
        agentId: item.agentId,
        hostname: item.hostname,
        instructionId: item.instructionId,
        status: item.status,
        answer: '',
      }));
      setBatchResults(initial);
      setBatchNote(`已下发给 ${initial.length} 台，等待执行…`);
      let current = initial;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = await Promise.all(initial.map(async (item) => {
          const detail = await getAgentInstruction(item.agentId, item.instructionId).catch(() => null);
          return detail
            ? {
                ...item,
                status: detail.status,
                answer: detail.answer,
              }
            : item;
        }));
        setBatchResults(current);
        if (current.every((item) => ['completed', 'failed', 'canceled', 'expired'].includes(item.status))) break;
      }
      setBatchNote(`批量指令完成：${current.filter((item) => item.status === 'completed').length} 成功 / ${current.length} 台`);
      setBatchIds([]);
      setBatchText('');
    } catch (caught) {
      setBatchNote(caught instanceof Error ? caught.message : '批量指令下发失败');
    } finally {
      setBatchBusy(false);
    }
  }

  async function saveInstructionTemplate() {
    if (!instructionText.trim()) return;
    const name = window.prompt('模板名称', instructionText.trim().slice(0, 20));
    if (!name?.trim()) return;
    try {
      const template = await createAgentInstructionTemplate(name.trim(), instructionText.trim(), templateScope);
      setInstructionTemplates((current) => [template, ...current]);
      setInstructionNote('模板已保存');
    } catch {
      setInstructionError('模板保存失败：名称可能已存在');
    }
  }

  async function removeInstructionTemplate(id: string) {
    try {
      await deleteAgentInstructionTemplate(id);
      setInstructionTemplates((current) => current.filter((item) => item.id !== id));
    } catch {
      setInstructionError('模板删除失败');
    }
  }

  async function editInstructionTemplate(template: AgentInstructionTemplate) {
    const name = window.prompt('模板名称', template.name);
    if (!name?.trim()) return;
    const instruction = window.prompt('模板指令', template.instruction);
    if (!instruction?.trim()) return;
    try {
      const updated = await updateAgentInstructionTemplate(template.id, name.trim(), instruction.trim());
      setInstructionTemplates((current) => current.map((item) => item.id === updated.id ? updated : item));
      setInstructionNote('模板已更新');
    } catch {
      setInstructionError('模板更新失败');
    }
  }

  function exportBatchResults() {
    if (batchResults.length === 0) return;
    const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const rows = [
      ['hostname', 'status', 'instructionId', 'answer'],
      ...batchResults.map((item) => [item.hostname, item.status, item.instructionId, item.answer]),
    ];
    const csv = rows.map((row) => row.map(escape).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `agent-instructions-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const pageCount = fleet ? Math.max(1, Math.ceil(fleet.total / fleet.pageSize)) : 1;
  const staleAgents = (keyStatus?.agents ?? []).filter((agent) => agent.valid === false);
  const activeKeyId = keyStatus?.keys.find((key) => key.active)?.keyId ?? '未配置';

  return (
    <DesignShell
      active="agents"
      eyebrow="Operating System Agents"
      title="纳管操作系统智能体"
      subtitle="按应用系统聚合主机、操作系统配置、应用部署与 Agent 状态；面向大规模主机的发现、检索与运维入口。"
      onBack={onBack}
      actions={<button type="button" className="btn btn-primary" onClick={() => void openInstall()}>一键安装 Agent</button>}
    >
      {error ? <p role="alert">{error}</p> : null}
      {install ? (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>一键安装 Agent</h2><button type="button" className="btn btn-ghost btn-sm" onClick={() => setInstall(null)}>关闭</button></div>
          <div className="card-body">
            <p className="muted">在目标机以 root / 管理员执行。Agent 仅主动出站连接控制面，不开放入站端口。</p>
            <h3>Linux</h3>
            <pre className="mono install-command">{install.linux}</pre>
            <h3>Windows</h3>
            <pre className="mono install-command">{install.windows}</pre>
          </div>
        </section>
      ) : null}

      <div className="status-strip fleet-summary">
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-server" /></svg></span><div><strong>纳管主机</strong><span>{fleet?.summary.total ?? 0} 台</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>在线</strong><span>{fleet?.summary.online ?? 0} 台</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>离线</strong><span>{fleet?.summary.offline ?? 0} 台</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-grid" /></svg></span><div><strong>应用系统</strong><span>{fleet?.summary.appSystems ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-bolt" /></svg></span><div><strong>已发现应用</strong><span>{fleet?.summary.applications ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-eye" /></svg></span><div><strong>配置发现</strong><span>{fleet?.summary.discovered ?? 0} / {fleet?.summary.total ?? 0}</span></div></div>
      </div>

      {staleAgents.length > 0 ? (
        <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 12 }}>
          <div className="card-body">
            <div className="row-between">
              <div>
                <strong>命令密钥待更新</strong>
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  当前签名密钥 {activeKeyId}；{staleAgents.length} 台 Agent 仍在使用旧 key，下一次心跳后应自动切换。
                </p>
              </div>
              <span className="badge badge-warn">{staleAgents.length} 台</span>
            </div>
          </div>
        </div>
      ) : null}

      <section className="app-system-strip">
        <div className="section-heading">
          <div><div className="eyebrow">Application Systems</div><h2>应用系统视图</h2></div>
          <div className="row-sm"><span className="muted">按归属过滤主机</span><button type="button" className="btn btn-outline btn-sm" onClick={() => void addAppSystem()}>新增应用系统</button></div>
        </div>
        <div className="app-system-scroll">
          <button type="button" className={`app-system-card${appSystemId === '' ? ' is-active' : ''}`} onClick={() => void openAppSystemAccess('')}>
            <span className="app-system-name">全部系统</span>
            <span className="app-system-meta">{fleet?.summary.total ?? 0} 台主机</span>
            <span className="bar"><i style={{ width: '100%' }} /></span>
          </button>
          {fleet?.appSystems.map((system) => (
            <button key={system.id} type="button" className={`app-system-card${appSystemId === system.id ? ' is-active' : ''}`} onClick={() => void openAppSystemAccess(system.id)}>
              <span className="app-system-top"><strong>{system.name}</strong><span className={`badge ${criticalityClass(system.criticality)}`}>{system.criticality}</span></span>
              <span className="app-system-meta">{system.onlineCount}/{system.agentCount} 在线 · {system.owner ?? '未指定负责人'}</span>
              <span className="bar"><i style={{ width: `${system.agentCount ? (system.onlineCount / system.agentCount) * 100 : 0}%` }} /></span>
            </button>
          ))}
          {fleet?.appSystems.length === 0 ? <span className="muted app-system-empty">暂无应用系统，主机可在详情中归属。</span> : null}
        </div>
      </section>

      {appSystemId ? (
        <AppSystemAccessPanel
          topology={accessTopology}
          loading={accessLoading}
          onDrill={(id) => void openAppSystemAccess(id)}
          onClose={() => { setAppSystemId(''); setAccessTopology(null); }}
        />
      ) : null}

      {healthChecks.some((check) => check.findings.some((finding) => finding.status !== 'healthy')) ? (
        <section className="app-health-panel">
          <div className="section-heading">
            <div><div className="eyebrow">Root Cause</div><h2>应用系统健康与根因定位</h2></div>
            <span className="muted">Agent 异常触发 · 自动关联全系统节点</span>
          </div>
          <div className="app-health-grid">
            {healthChecks.filter((check) => check.findings.some((finding) => finding.status !== 'healthy')).slice(0, 4).map((check) => (
              <button
                key={check.id}
                type="button"
                className="app-health-card"
                onClick={() => {
                  setAppSystemId(check.appSystemId);
                  setPage(1);
                }}
              >
                <div className="app-health-head">
                  <strong>{check.appSystemName}</strong>
                  <span className="badge badge-danger">异常</span>
                  <span className="muted">{relativeTime(check.createdAt)}</span>
                </div>
                <p>{check.summary}</p>
                <div className="app-health-cause"><span>根因</span><strong>{check.rootCause}</strong></div>
                <div className="app-health-nodes">
                  {check.findings.map((finding) => (
                    <span key={finding.agentId} className={`health-node ${finding.status}`}>
                      <span className={`severity-dot ${finding.status === 'critical' ? 'critical' : finding.status === 'warning' ? 'warning' : 'info'}`} />
                      {finding.hostname}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {fleet?.alerts && fleet.alerts.length > 0 ? (
        <section className="agent-alert-strip">
          <div className="agent-alert-head">
            <span className="agent-alert-icon"><svg><use href="/icons.svg#i-alert" /></svg></span>
            <strong>智能体主动上报的异常</strong>
            <span className="badge badge-warn">{fleet.alerts.length} 条待处理</span>
            <span className="muted">Agent 自巡航发现，已同步到消息中心</span>
          </div>
          <div className="agent-alert-list">
            {fleet.alerts.slice(0, 4).map((event) => (
              <button key={event.id} type="button" className="agent-alert-row" onClick={() => { if (event.agentId) void openDetail(event.agentId); }}>
                <span className={`severity-dot ${event.severity}`} />
                <strong>{event.hostname ?? event.agentId}</strong>
                <span>{event.title}</span>
                <span className="agent-alert-detail">{event.detail}</span>
                <span className="muted">{relativeTime(event.detectedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card fleet-card">
        <div className="fleet-toolbar">
          <div className="fleet-toolbar-title">
            <h2>主机清单</h2>
            <span className="muted">{loading ? '加载中…' : `共 ${fleet?.total ?? 0} 台`}</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setBatchOpen((current) => !current)}>批量指令</button>
          </div>
          <div className="fleet-filters">
            <label className="fleet-search">
              <svg><use href="/icons.svg#i-search" /></svg>
              <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索主机、IP、系统或应用系统" aria-label="搜索主机" />
            </label>
            <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} aria-label="按状态过滤">
              <option value="">全部状态</option>
              <option value="online">在线</option>
              <option value="offline">离线</option>
            </select>
            <select value={os} onChange={(event) => { setOs(event.target.value); setPage(1); }} aria-label="按操作系统过滤">
              <option value="">全部系统</option>
              <option value="linux">Linux</option>
              <option value="windows">Windows</option>
            </select>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setReloadToken((token) => token + 1)}>刷新</button>
          </div>
        </div>
        {batchOpen ? (
          <div className="card-body stack" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-subtle)' }}>
            <p className="muted">选择一个或多个在线 Agent（最多 8 台），自然语言会按只读意图分别下发。</p>
            <div className="row-sm" style={{ flexWrap: 'wrap' }}>
              {(fleet?.items ?? []).filter((agent) => agent.status === 'online').map((agent) => (
                <label key={agent.id} className="badge badge-neutral" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={batchIds.includes(agent.id)}
                    onChange={(event) => setBatchIds((current) => event.target.checked
                      ? [...current, agent.id].slice(0, 8)
                      : current.filter((id) => id !== agent.id))}
                    style={{ marginRight: 6 }}
                  />
                  {agent.hostname}
                </label>
              ))}
            </div>
            <div className="field">
              <label htmlFor="batch-instruction">批量指令内容</label>
              <textarea id="batch-instruction" rows={2} value={batchText} onChange={(event) => setBatchText(event.target.value)} placeholder="例如：系统运行多久了？看看磁盘使用率。" />
            </div>
            <div className="row-sm">
              <button type="button" className="btn btn-primary btn-sm" disabled={batchBusy || batchIds.length === 0 || !batchText.trim()} onClick={() => void sendBatchInstruction()}>下发到 {batchIds.length} 台</button>
              {batchResults.length > 0 ? <button type="button" className="btn btn-outline btn-sm" onClick={exportBatchResults}>导出 CSV</button> : null}
              {batchNote ? <span className="muted">{batchNote}</span> : null}
            </div>
            {batchResults.length > 0 ? (
              <div className="command-history">
                {batchResults.map((item) => (
                  <button
                    key={item.instructionId}
                    type="button"
                    className="command-row"
                    onClick={() => void openDetail(item.agentId)}
                  >
                    <span className="mono">{item.hostname}</span>
                    <span className={`badge ${item.status === 'completed' ? 'badge-ok' : item.status === 'failed' ? 'badge-danger' : 'badge-neutral'}`}>{item.status}</span>
                    <span className="muted">{item.answer ? item.answer.split('\n')[0]?.slice(0, 100) : '等待结果…'}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="table fleet-table">
            <thead>
              <tr><th>状态</th><th>主机 / IP</th><th>应用系统</th><th>操作系统配置</th><th>应用部署</th><th>Agent</th><th>最近上报</th><th /></tr>
            </thead>
            <tbody>
              {fleet?.items.map((agent) => (
                <tr key={agent.id} onClick={() => void openDetail(agent.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') void openDetail(agent.id); }}>
                  <td><span className={`status-pill ${agent.status}`}><span className={`dot ${agent.status === 'online' ? 'dot-ok' : 'dot-warn'}`} />{statusLabel(agent.status)}</span></td>
                  <td>
                    <strong className="fleet-host">{agent.hostname}</strong>
                    <span className="fleet-sub mono">{text(agent.systemInfo.ip)} · {agent.name}</span>
                  </td>
                  <td>{agent.appSystem ? <span className="badge badge-neutral">{agent.appSystem.name}</span> : <span className="muted">未归属</span>}</td>
                  <td>
                    <span className="fleet-main">{text(agent.systemInfo.osPretty || agent.systemInfo.osName || agent.os)}</span>
                    <span className="fleet-sub">内核 {text(agent.systemInfo.kernel)} · {number(agent.systemInfo.cpuCores)}C / {number(agent.systemInfo.memoryTotalGB, 1)}G</span>
                  </td>
                  <td>
                    <span className="fleet-main">{agent.applications.length} 个应用</span>
                    <span className="app-chips">{(agent.applications as AgentApplication[]).slice(0, 2).map((application) => <span key={text(application.name)} className="chip">{text(application.name)}</span>)}</span>
                  </td>
                  <td><span className="fleet-main mono">{text(agent.agentInfo.version || agent.version)}</span><span className="fleet-sub">{agent.discoveryAt ? '已发现配置' : '待发现'}</span></td>
                  <td><span className="fleet-sub">{relativeTime(agent.lastSeen)}</span></td>
                  <td><button type="button" className="btn btn-outline btn-sm" onClick={(event) => { event.stopPropagation(); void openDetail(agent.id); }}>详情</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && fleet?.items.length === 0 ? <div className="empty-state fleet-empty"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-server" /></svg></span><h3>没有匹配的主机</h3><p className="muted">调整筛选条件，或先安装 Agent 并等待首次上报。</p></div> : null}
        <div className="fleet-pager">
          <span className="muted">第 {fleet?.page ?? 1} / {pageCount} 页 · 每页 {fleet?.pageSize ?? pageSize} 条</span>
          <div className="row-sm">
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} aria-label="每页条数">
              <option value={20}>20 条/页</option>
              <option value={50}>50 条/页</option>
              <option value={100}>100 条/页</option>
            </select>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={(fleet?.page ?? 1) <= 1}>上一页</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={(fleet?.page ?? 1) >= pageCount}>下一页</button>
          </div>
        </div>
      </section>

      {detailId ? (
        <div className="agent-detail-overlay" onClick={() => setDetailId(null)}>
          <aside className="agent-detail" onClick={(event) => event.stopPropagation()} aria-label="智能体详情">
            <header className="agent-detail-head">
              <div className="agent-detail-title">
                <span className={`status-pill ${detail?.status ?? 'offline'}`}><span className={`dot ${detail?.status === 'online' ? 'dot-ok' : 'dot-warn'}`} />{statusLabel(detail?.status ?? 'offline')}</span>
                <h2>{detail?.hostname ?? '加载中…'}</h2>
                <span className="mono muted">{detail?.id ?? detailId}</span>
              </div>
              <button type="button" className="topbar-icon" aria-label="关闭详情" onClick={() => setDetailId(null)}><svg><use href="/icons.svg#i-x" /></svg></button>
            </header>
            {detailLoading ? <p className="muted detail-loading">加载智能体详情…</p> : detail ? (
              <>
                <div className="agent-detail-toolbar">
                  <label>应用系统
                    <select value={detail.appSystem?.id ?? ''} onChange={(event) => void assignAppSystem(event.target.value)}>
                      <option value="">未归属</option>
                      {fleet?.appSystems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
                    </select>
                  </label>
                  <button type="button" className="btn btn-outline btn-sm" disabled={commandBusy} onClick={() => void runCommand('diagnostics')}>执行诊断</button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={commandBusy} onClick={() => void runCommand('discovery')}>重新发现配置</button>
                </div>
                <nav className="detail-tabs">
                  {([['overview', '概览'], ['system', '系统配置'], ['apps', '应用部署'], ['agent', 'Agent'], ['commands', '命令历史'], ['instruction', '自然语言'], ['alerts', `告警${detailEvents.filter((event) => event.status === 'open').length ? ` (${detailEvents.filter((event) => event.status === 'open').length})` : ''}`]] as Array<[DetailTab, string]>).map(([id, label]) => (
                    <button key={id} type="button" className={detailTab === id ? 'is-active' : ''} onClick={() => setDetailTab(id)}>{label}</button>
                  ))}
                </nav>
                <div className="agent-detail-body">
                  {detailTab === 'overview' ? (
                    <div className="detail-overview">
                      <div className="detail-info-grid">
                        <div><span>操作系统</span><strong>{text(detail.systemInfo.osPretty || detail.systemInfo.osName || detail.os)}</strong></div>
                        <div><span>内核</span><strong className="mono">{text(detail.systemInfo.kernel)}</strong></div>
                        <div><span>主 IP</span><strong className="mono">{text(detail.systemInfo.ip)}</strong></div>
                        <div><span>时区</span><strong>{text(detail.systemInfo.timezone)}</strong></div>
                        <div><span>CPU / 内存</span><strong>{number(detail.systemInfo.cpuCores)}C / {number(detail.systemInfo.memoryTotalGB, 1)}G</strong></div>
                        <div><span>磁盘可用</span><strong>{number(detail.systemInfo.diskFreeGB, 1)}G / {number(detail.systemInfo.diskTotalGB, 1)}G</strong></div>
                      </div>
                      <div className="detail-split">
                        <div><div className="eyebrow">应用系统</div><strong>{detail.appSystem?.name ?? '未归属'}</strong><p className="muted">{detail.appSystem?.owner ?? '未指定负责人'}</p></div>
                        <div><div className="eyebrow">应用部署</div><strong>{detail.applications.length} 个</strong><p className="muted">{detail.applications.slice(0, 3).map((application) => text(application.name)).join('、') || '未发现应用'}</p></div>
                        <div><div className="eyebrow">Agent 版本</div><strong className="mono">{text(detail.agentInfo.version || detail.version)}</strong><p className="muted">{detail.agentInfo.serviceStatus ? `服务 ${text(detail.agentInfo.serviceStatus)}` : '状态未知'}</p></div>
                        <div><div className="eyebrow">命令签名</div><strong className="mono">{detail.commandKeyId ?? '未上报'}</strong><p className="muted">注册/心跳同步</p></div>
                        <div><div className="eyebrow">客户端证书</div><strong>{detail.tlsCertExpiresAt ? relativeTime(detail.tlsCertExpiresAt) : '未上报'}</strong><p className="muted mono">{detail.tlsCertSerial ?? '无序列号'}</p></div>
                      </div>
                      {patrolPolicy ? (
                        <div className="card">
                          <div className="card-head"><h2>自主巡航</h2><span className={`badge ${patrolPolicy.enabled ? 'badge-ok' : 'badge-neutral'}`}>{patrolPolicy.enabled ? '运行中' : '已停用'}</span></div>
                          <div className="card-body stack">
                            <p className="muted">每 {patrolPolicy.intervalSeconds} 秒采集指标；超过阈值自动上报并触发平台模型根因分析。</p>
                            <div className="form-grid">
                              <div className="field">
                                <label htmlFor="patrol-interval">巡检间隔（秒）</label>
                                <input id="patrol-interval" type="number" min={30} max={3600} value={patrolPolicy.intervalSeconds} onChange={(event) => setPatrolPolicy({ ...patrolPolicy, intervalSeconds: Number(event.target.value) })} />
                              </div>
                              <div className="field">
                                <label htmlFor="patrol-disk">磁盘可用下限（%）</label>
                                <input id="patrol-disk" type="number" min={1} max={99} value={patrolPolicy.diskFreePct} onChange={(event) => setPatrolPolicy({ ...patrolPolicy, diskFreePct: Number(event.target.value) })} />
                              </div>
                              <div className="field">
                                <label htmlFor="patrol-mem">内存使用上限（%）</label>
                                <input id="patrol-mem" type="number" min={1} max={100} value={patrolPolicy.memLoadPct} onChange={(event) => setPatrolPolicy({ ...patrolPolicy, memLoadPct: Number(event.target.value) })} />
                              </div>
                              <div className="field">
                                <label htmlFor="patrol-load">1 分钟负载上限</label>
                                <input id="patrol-load" type="number" min={0} step={0.1} value={patrolPolicy.load1} onChange={(event) => setPatrolPolicy({ ...patrolPolicy, load1: Number(event.target.value) })} />
                              </div>
                            </div>
                            <label className="muted"><input type="checkbox" checked={patrolPolicy.enabled} onChange={(event) => setPatrolPolicy({ ...patrolPolicy, enabled: event.target.checked })} /> 启用自主巡航</label>
                            <div className="form-actions">
                              <button type="button" className="btn btn-primary btn-sm" disabled={patrolBusy} onClick={() => void savePatrolPolicy()}>{patrolBusy ? '保存中…' : '保存阈值'}</button>
                              {patrolNote ? <span className="muted">{patrolNote}</span> : null}
                            </div>
                          </div>
                        </div>
                      ) : null}
                      {inventory.length > 0 ? (
                        <div className="card">
                          <div className="card-head"><h2>巡检对象</h2><span className="badge badge-neutral">{inventory.length} 项</span></div>
                          <div className="card-body stack">
                            <p className="muted">按类型筛选；勾选「重要 + 监控」后，Agent 巡航会检查这些对象，异常时自动触发排障。</p>
                            <div className="row-sm">
                              {(['all', 'process', 'port', 'service', 'ops_tool'] as const).map((kind) => (
                                <button key={kind} type="button" className={`btn btn-sm ${inventoryFilter === kind ? 'btn-primary' : 'btn-outline'}`} onClick={() => setInventoryFilter(kind)}>
                                  {kind === 'all' ? '全部' : kind === 'process' ? '进程' : kind === 'port' ? '端口' : kind === 'service' ? '服务' : '运维工具'} {kind === 'all' ? inventory.length : inventory.filter((item) => item.kind === kind).length}
                                </button>
                              ))}
                            </div>
                            <div className="inventory-list">
                              {inventory.filter((item) => inventoryFilter === 'all' || item.kind === inventoryFilter).slice(0, 1000).map((item) => (
                                <div key={item.id} className="inventory-row">
                                  <span className={`badge ${item.kind === 'process' ? 'badge-info' : item.kind === 'port' ? 'badge-warn' : 'badge-neutral'}`}>
                                    {item.kind === 'process' ? '进程' : item.kind === 'port' ? '端口' : item.kind === 'service' ? '服务' : '运维工具'}
                                  </span>
                                  <div className="inventory-main">
                                    <strong className="mono">{item.name}</strong>
                                    <span className="inventory-path mono">{inventoryDetail(item)}</span>
                                  </div>
                                  <label className="inventory-check"><input type="checkbox" checked={item.important} onChange={() => void toggleInventory(item, 'important')} /> 重要</label>
                                  <label className="inventory-check"><input type="checkbox" checked={item.monitored} onChange={() => void toggleInventory(item, 'monitored')} /> 监控</label>
                                  <div className="inventory-actions">
                                    {item.kind === 'process' ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void promoteInventory(item)}>转为运维工具</button> : null}
                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeInventory(item)}>删除</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {detailTab === 'system' ? (
                    <div className="detail-kv">
                      {Object.entries(detail.systemInfo).map(([key, value]) => <div key={key}><span>{SYSTEM_LABELS[key] ?? key}</span><strong>{text(value)}</strong></div>)}
                      <div><span>最后发现</span><strong>{relativeTime(detail.discoveryAt)}</strong></div>
                    </div>
                  ) : null}
                  {detailTab === 'apps' ? (
                    detail.applications.length > 0 ? (
                      <div className="table-wrap">
                        <table className="table detail-apps">
                          <thead><tr><th>应用</th><th>类型</th><th>版本</th><th>状态</th><th>端口</th><th>部署方式</th></tr></thead>
                          <tbody>{detail.applications.map((application, index) => <tr key={`${text(application.name)}-${index}`}><td><strong>{text(application.name)}</strong></td><td>{text(application.kind)}</td><td className="mono">{text(application.version)}</td><td>{text(application.status)}</td><td className="mono">{appPorts(application)}</td><td>{text(application.deploy)}</td></tr>)}</tbody>
                        </table>
                      </div>
                    ) : <p className="muted detail-loading">未发现应用部署。执行「重新发现配置」后再次查看。</p>
                  ) : null}
                  {detailTab === 'agent' ? (
                    <div className="detail-kv">
                      {Object.entries(detail.agentInfo).map(([key, value]) => <div key={key}><span>{AGENT_LABELS[key] ?? key}</span><strong>{text(value)}</strong></div>)}
                      <div><span>能力</span><strong>{detail.tags.join(', ') || '—'}</strong></div>
                    </div>
                  ) : null}
                  {detailTab === 'commands' ? (
                    detailCommands.length > 0 ? <div className="command-history">{detailCommands.map((command) => <div key={command.id} className="command-row"><span className="mono">{command.type === 'ai_diagnose' ? 'AI 诊断' : command.type === 'discovery' ? '配置发现' : command.type === 'diagnostics' ? '主机诊断' : command.type === 'inspect' ? '主机检查' : command.type}</span><span className={`badge ${command.status === 'completed' ? 'badge-ok' : 'badge-neutral'}`}>{command.status}</span><span className="muted">{relativeTime(command.createdAt)}</span></div>)}</div> : <p className="muted detail-loading">暂无命令记录。</p>
                  ) : null}
                  {detailTab === 'instruction' ? (
                    <div className="stack">
                      <div className="card">
                        <div className="card-head"><h2>自然语言指令</h2><span className="badge badge-neutral">只读</span></div>
                        <div className="card-body stack">
                          <p className="muted">目标固定为当前智能体：<strong>{detail.hostname}</strong>。首版只执行只读检查，写操作请在审批流程中发起。</p>
                          <div className="field">
                            <label htmlFor="agent-instruction-template">模板</label>
                            <select
                              id="agent-instruction-template"
                              defaultValue=""
                              onChange={(event) => {
                                if (event.target.value) setInstructionText(event.target.value);
                                event.target.value = '';
                              }}
                            >
                              <option value="">选择模板…</option>
                              {BUILTIN_INSTRUCTION_TEMPLATES.map((template) => (
                                <option key={`builtin-${template.name}`} value={template.instruction}>{template.name}</option>
                              ))}
                              {instructionTemplates.map((template) => (
                                <option key={template.id} value={template.instruction}>{template.name}</option>
                              ))}
                            </select>
                          </div>
                          <div className="field">
                            <label htmlFor="agent-instruction">指令内容</label>
                            <textarea
                              id="agent-instruction"
                              rows={3}
                              value={instructionText}
                              onChange={(event) => setInstructionText(event.target.value)}
                              placeholder="例如：系统运行多久了？看看磁盘为什么满了。"
                            />
                          </div>
                          <div className="row-sm">
                            <button type="button" className="btn btn-primary" disabled={instructionBusy || !instructionText.trim()} onClick={() => void sendInstruction()}>
                              {instructionBusy ? '执行中…' : '下发指令'}
                            </button>
                            {instructionBusy && activeInstructionId ? <button type="button" className="btn btn-outline" onClick={() => void cancelInstruction()}>取消指令</button> : null}
                            <button type="button" className="btn btn-outline" disabled={!instructionText.trim()} onClick={() => void saveInstructionTemplate()}>保存模板</button>
                            <select aria-label="模板可见范围" value={templateScope} onChange={(event) => setTemplateScope(event.target.value === 'private' ? 'private' : 'tenant')}>
                              <option value="tenant">租户共享</option>
                              <option value="private">仅自己</option>
                            </select>
                            {instructionTemplates.length > 0 ? (
                              <div className="command-history" style={{ width: '100%' }}>
                                {instructionTemplates.map((template) => (
                                  <div key={template.id} className="command-row">
                                    <span>{template.name}</span>
                                    <span className={`badge ${template.scope === 'private' ? 'badge-neutral' : 'badge-ok'}`}>{template.scope === 'private' ? '私有' : '共享'}</span>
                                    <span className="muted">{template.instruction.slice(0, 80)}</span>
                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void editInstructionTemplate(template)}>编辑</button>
                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeInstructionTemplate(template.id)}>删除</button>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {instructionNote ? <span className="muted">{instructionNote}</span> : null}
                          </div>
                          {instructionError ? <p role="alert">{instructionError}</p> : null}
                        </div>
                      </div>
                      {instructionResult ? (
                        <div className="card">
                          <div className="card-head">
                            <h2>执行结果</h2>
                            <span className={`badge ${instructionResult.status === 'completed' ? 'badge-ok' : 'badge-neutral'}`}>{instructionResult.status}</span>
                          </div>
                          <div className="card-body stack">
                            {instructionResult.intent ? <p className="muted">意图：{instructionResult.intent.kind} · 只读 · 置信度 {instructionResult.intent.confidence}</p> : null}
                            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{instructionResult.answer || '等待 Agent 返回结果…'}</pre>
                            {instructionResult.toolsUsed?.length ? <p className="muted">工具：{instructionResult.toolsUsed.join(', ')}</p> : null}
                            {instructionResult.evidence ? (
                              <details>
                                <summary className="muted">查看结构化证据</summary>
                                <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(instructionResult.evidence, null, 2)}</pre>
                              </details>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      {instructionHistory.length > 0 ? (
                        <div className="card">
                          <div className="card-head"><h2>最近指令</h2><span className="muted">{instructionHistory.length} 条</span></div>
                          <div className="card-body">
                            <div className="command-history">
                              {instructionHistory.map((item) => (
                                <button
                                  key={item.instructionId}
                                  type="button"
                                  className="command-row"
                                  onClick={() => {
                                    void getAgentInstruction(detail.id, item.instructionId)
                                      .then((loaded) => {
                                        setInstructionResult(loaded);
                                        setInstructionNote(`指令状态：${loaded.status}`);
                                      })
                                      .catch(() => setInstructionError('指令加载失败'));
                                  }}
                                >
                                  <span>{item.instruction ?? '自然语言指令'}</span>
                                  <span className={`badge ${item.status === 'completed' ? 'badge-ok' : 'badge-neutral'}`}>{item.status}</span>
                                  <span className="muted">{relativeTime(item.createdAt)}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {detailTab === 'alerts' ? (
                    detailEvents.length > 0 ? (
                      <div className="agent-event-list">
                        {detailEvents.map((event) => (
                          <div key={event.id} className={`agent-event ${event.status}`}>
                            <span className={`severity-dot ${event.severity}`} />
                            <div className="agent-event-copy">
                              <strong>{event.title}</strong>
                              <p>{event.detail}</p>
                              <span className="muted">{relativeTime(event.detectedAt)} · {event.status === 'open' ? '待处理' : '已恢复'} · {event.fingerprint}</span>
                            </div>
                            <span className={`badge ${event.severity === 'critical' ? 'badge-danger' : 'badge-warn'}`}>{event.severity}</span>
                          </div>
                        ))}
                      </div>
                    ) : <p className="muted detail-loading">暂无告警，Agent 自巡航未发现异常。</p>
                  ) : null}
                </div>
              </>
            ) : <p className="muted detail-loading">无法加载详情。</p>}
          </aside>
        </div>
      ) : null}
    </DesignShell>
  );
}
