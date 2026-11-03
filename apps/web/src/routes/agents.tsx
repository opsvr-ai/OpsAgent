import { useEffect, useState } from 'react';
import {
  createAgentCommand,
  getAgentInstallCommand,
  listAgents,
  type AgentCommandSummary,
  type AgentSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface AgentsProps {
  readonly onBack: () => void;
}

export function Agents({ onBack }: AgentsProps) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<Record<string, AgentCommandSummary>>({});
  const [install, setInstall] = useState<{ linux: string; windows: string } | null>(null);

  useEffect(() => {
    void listAgents()
      .then(setAgents)
      .catch(() => setError('Agent 加载失败'));
  }, []);

  async function runDiagnostics(id: string) {
    setError(null);
    try {
      const command = await createAgentCommand(id, 'diagnostics');
      setCommands((current) => ({ ...current, [id]: command }));
    } catch {
      setError('命令下发失败');
    }
  }

  async function runAiDiagnosis(id: string) {
    setError(null);
    try {
      const command = await createAgentCommand(id, 'ai_diagnose');
      setCommands((current) => ({ ...current, [id]: command }));
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
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="row-sm" style={{ marginBottom: 16 }}>
        <button type="button" className="btn btn-primary" onClick={() => void openInstall()}>一键安装 Agent</button>
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
                <p className="muted mono">{JSON.stringify(agent.metrics)}</p>
              ) : null}
              {commands[agent.id] ? (
                <p className="muted">诊断命令：{commands[agent.id]?.status}</p>
              ) : null}
              <button type="button" className="btn btn-outline" onClick={() => void runDiagnostics(agent.id)}>执行诊断</button>
              <button type="button" className="btn btn-primary" onClick={() => void runAiDiagnosis(agent.id)}>AI 诊断</button>
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
