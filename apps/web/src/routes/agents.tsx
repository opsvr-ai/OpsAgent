import { useEffect, useState } from 'react';
import {
  assignAgentAppSystem,
  createAgentCommand,
  getAgentDetail,
  getAgentEvents,
  getAgentFleet,
  getAgentInstallCommand,
  getAppSystemHealth,
  listAgentCommands,
  type AgentApplication,
  type AgentCommandSummary,
  type AgentEventSummary,
  type AgentFleetResponse,
  type AgentSummary,
  type AppHealthCheck,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { relativeTime } from '../format.js';

export interface AgentsProps {
  readonly onBack: () => void;
}

type DetailTab = 'overview' | 'system' | 'apps' | 'agent' | 'commands' | 'alerts';

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

export function Agents({ onBack }: AgentsProps) {
  const [fleet, setFleet] = useState<AgentFleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [appSystemId, setAppSystemId] = useState('');
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
  const [healthChecks, setHealthChecks] = useState<AppHealthCheck[]>([]);
  const [commandBusy, setCommandBusy] = useState(false);

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

  const pageCount = fleet ? Math.max(1, Math.ceil(fleet.total / fleet.pageSize)) : 1;

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

      <section className="app-system-strip">
        <div className="section-heading">
          <div><div className="eyebrow">Application Systems</div><h2>应用系统视图</h2></div>
          <span className="muted">按归属过滤主机</span>
        </div>
        <div className="app-system-scroll">
          <button type="button" className={`app-system-card${appSystemId === '' ? ' is-active' : ''}`} onClick={() => { setAppSystemId(''); setPage(1); }}>
            <span className="app-system-name">全部系统</span>
            <span className="app-system-meta">{fleet?.summary.total ?? 0} 台主机</span>
            <span className="bar"><i style={{ width: '100%' }} /></span>
          </button>
          {fleet?.appSystems.map((system) => (
            <button key={system.id} type="button" className={`app-system-card${appSystemId === system.id ? ' is-active' : ''}`} onClick={() => { setAppSystemId(system.id); setPage(1); }}>
              <span className="app-system-top"><strong>{system.name}</strong><span className={`badge ${criticalityClass(system.criticality)}`}>{system.criticality}</span></span>
              <span className="app-system-meta">{system.onlineCount}/{system.agentCount} 在线 · {system.owner ?? '未指定负责人'}</span>
              <span className="bar"><i style={{ width: `${system.agentCount ? (system.onlineCount / system.agentCount) * 100 : 0}%` }} /></span>
            </button>
          ))}
          {fleet?.appSystems.length === 0 ? <span className="muted app-system-empty">暂无应用系统，主机可在详情中归属。</span> : null}
        </div>
      </section>

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
                  {([['overview', '概览'], ['system', '系统配置'], ['apps', '应用部署'], ['agent', 'Agent'], ['commands', '命令历史'], ['alerts', `告警${detailEvents.filter((event) => event.status === 'open').length ? ` (${detailEvents.filter((event) => event.status === 'open').length})` : ''}`]] as Array<[DetailTab, string]>).map(([id, label]) => (
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
                      </div>
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
