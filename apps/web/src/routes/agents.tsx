import { useEffect, useState } from 'react';
import {
  createAgentCommand,
  getAgentInstallCommand,
  listAgentCommands,
  listAgents,
  type AgentCommandSummary,
  type AgentSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { relativeTime } from '../format.js';

export interface AgentsProps {
  readonly onBack: () => void;
}

const METRIC_LABELS: Record<string, string> = {
  cpuCores: 'CPU 核数',
  goroutines: 'Goroutines',
  heapMB: 'Heap MB',
  uptimeSec: '运行秒数',
  memTotalGB: '内存总量 GB',
  memAvailableGB: '可用内存 GB',
  memLoadPct: '内存负载 %',
  diskTotalGB: '磁盘总量 GB',
  diskFreeGB: '磁盘可用 GB',
};

function metricValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

export function Agents({ onBack }: AgentsProps) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<Record<string, AgentCommandSummary>>({});
  const [history, setHistory] = useState<Record<string, AgentCommandSummary[]>>({});
  const [install, setInstall] = useState<{ linux: string; windows: string } | null>(null);

  useEffect(() => {
    void listAgents()
      .then(setAgents)
      .catch(() => setError('Agent 加载失败'));
  }, []);

  async function openHistory(id: string) {
    setError(null);
    try {
      const items = await listAgentCommands(id);
      setHistory((current) => ({ ...current, [id]: items.slice(0, 5) }));
    } catch {
      setError('命令历史加载失败');
    }
  }

  async function runDiagnostics(id: string) {
    setError(null);
    try {
      const command = await createAgentCommand(id, 'diagnostics');
      setCommands((current) => ({ ...current, [id]: command }));
      setHistory((current) => ({ ...current, [id]: [command, ...(current[id] ?? [])].slice(0, 5) }));
    } catch {
      setError('命令下发失败');
    }
  }

  async function runAiDiagnosis(id: string) {
    setError(null);
    try {
      const command = await createAgentCommand(id, 'ai_diagnose');
      setCommands((current) => ({ ...current, [id]: command }));
      setHistory((current) => ({ ...current, [id]: [command, ...(current[id] ?? [])].slice(0, 5) }));
    } catch {
      setError('AI 诊断下发失败');
    }
  }

  async function openInstall() {
    setError(null);
    try {
      const [linux, windows] = await Promise.all([
        getAgentInstallCommand('linux'),
        getAgentInstallCommand('windows'),
      ]);
      setInstall({ linux: linux.command, windows: windows.command });
    } catch {
      setError('安装命令生成失败，请确认平台已配置 enrollment token 与 agent 二进制');
    }
  }

  return (
    <DesignShell
      active="agents"
      eyebrow="Agents"
      title="服务器 Agent"
      subtitle="出站注册、心跳与能力发现；Agent 不开放入站端口。"
      onBack={onBack}
      actions={<button type="button" className="btn btn-primary" onClick={() => void openInstall()}>一键安装 Agent</button>}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="status-strip" style={{ marginBottom: 18 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-server" /></svg></span><div><strong>Agent 总数</strong><span>{agents?.length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>在线</strong><span>{agents?.filter((agent) => agent.status === 'online').length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>离线</strong><span>{agents?.filter((agent) => agent.status !== 'online').length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-clock" /></svg></span><div><strong>最近命令</strong><span>{Object.values(commands).length} 条</span></div></div>
      </div>
      {install ? (
        <section className="card">
          <div className="card-body">
            <h2>一键安装命令</h2>
            <p className="muted">在目标机以 root/管理员执行；脚本会下载 Agent、写入配置并注册开机启动。</p>
            <h3>Linux</h3>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{install.linux}</pre>
            <h3>Windows</h3>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{install.windows}</pre>
          </div>
        </section>
      ) : null}
      {agents === null ? <p className="muted">加载中…</p> : null}
      {agents?.length === 0 ? <p className="muted">暂无 Agent</p> : null}
      <section className="grid grid-3">
        {agents?.map((agent) => (
          <article key={agent.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className={`dot ${agent.status === 'online' ? 'dot-ok' : 'dot-warn'}`} />
                <span className="badge badge-neutral">{agent.status}</span>
              </div>
              <h3>{agent.name}</h3>
              <p className="muted">{agent.hostname}</p>
              <p className="muted">{agent.os}/{agent.arch} · v{agent.version}</p>
              {Object.keys(agent.metrics).length > 0 ? (
                <div className="metric-grid">
                  {Object.entries(agent.metrics).slice(0, 8).map(([key, value]) => (
                    <div key={key} className="metric-item">
                      <span>{METRIC_LABELS[key] ?? key}</span>
                      <strong>{metricValue(value)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
              {commands[agent.id] ? (
                <p className="muted">诊断命令：{commands[agent.id]?.status}</p>
              ) : null}
              <div className="row-sm">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void runDiagnostics(agent.id)}>执行诊断</button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void runAiDiagnosis(agent.id)}>AI 诊断</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openHistory(agent.id)}>命令历史</button>
              </div>
              {history[agent.id] ? (
                <div className="stack-sm" style={{ marginTop: 12, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
                  {history[agent.id]?.length === 0 ? <p className="muted">暂无命令</p> : null}
                  {(history[agent.id] ?? []).map((command) => (
                    <div key={command.id} className="row-between">
                      <span className="mono">{command.type === 'ai_diagnose' ? 'AI 诊断' : '主机诊断'}</span>
                      <span className={`badge ${command.status === 'completed' ? 'badge-ok' : 'badge-neutral'}`}>{command.status}</span>
                      <span className="muted">{relativeTime(command.createdAt)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
