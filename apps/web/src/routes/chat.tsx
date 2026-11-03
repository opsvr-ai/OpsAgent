import { useState, type FormEvent } from 'react';
import type { ApprovalRequestEvent, RuntimeEvent } from '@opsagent/contracts';
import { decideApproval, promptSession } from '../api/client.js';

export interface ChatProps {
  readonly sessionId: string;
  readonly roleView: string;
  readonly onBack: () => void;
}

export function Chat({ sessionId, roleView, onBack }: ChatProps) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequestEvent | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const text = input;
    setInput('');
    setBusy(true);
    try {
      for await (const item of promptSession(sessionId, text, crypto.randomUUID())) {
        setEvents((current) => [...current, item]);
        if (item.type === 'approval.request') setPendingApproval(item);
        if (item.type === 'session.done') setBusy(false);
      }
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!pendingApproval) return;
    await decideApproval(pendingApproval.approvalId, decision);
    setPendingApproval(null);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">OpsAgent</div>
        <div className="tenant">
          <strong>智能体会话</strong>
          <span>{roleView}</span>
        </div>
        <button type="button" onClick={onBack}>返回工作台</button>
      </aside>
      <main className="page">
        <header>
          <div className="eyebrow">Session</div>
          <h1>运维会话</h1>
          <span className="muted mono">{sessionId}</span>
        </header>

        <section className="events" aria-live="polite">
          {events.map((item, index) => {
            if (item.type === 'assistant.delta') {
              return <p key={index}>{item.text}</p>;
            }
            if (item.type === 'tool.call') {
              return (
                <div key={index} className="event">
                  <strong>{item.tool}</strong>
                  <span className="muted"> · {item.risk} · 调用</span>
                </div>
              );
            }
            if (item.type === 'tool.result') {
              return (
                <div key={index} className="event">
                  <strong>{item.tool}</strong>
                  <span className="muted"> · 已返回</span>
                </div>
              );
            }
            if (item.type === 'approval.request') {
              return (
                <div key={index} className="event approval">
                  <strong>需要审批：{item.action}</strong>
                  <span className="muted"> · {item.risk}</span>
                  <div className="actions">
                    <button type="button" onClick={() => void decide('approve')}>批准</button>
                    <button type="button" onClick={() => void decide('deny')}>拒绝</button>
                  </div>
                </div>
              );
            }
            if (item.type === 'session.done') {
              return <p key={index} className="done">完成</p>;
            }
            return <p key={index} className="muted">运行时错误：{item.code}</p>;
          })}
        </section>

        <form className="composer" onSubmit={send}>
          <label htmlFor="prompt">输入</label>
          <textarea
            id="prompt"
            rows={3}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={busy}
          />
          <button type="submit" disabled={busy}>发送</button>
        </form>
      </main>
    </div>
  );
}
