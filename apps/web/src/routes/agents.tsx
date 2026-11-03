import { useEffect, useState } from 'react';
import {
  createAgentCommand,
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

  return (
    <DesignShell
      active="agents"
      eyebrow="Agents"
      title="服务器 Agent"
      subtitle="出站注册、心跳与能力发现；Agent 不开放入站端口。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
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
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
