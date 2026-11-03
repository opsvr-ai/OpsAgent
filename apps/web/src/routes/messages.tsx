import { useEffect, useState } from 'react';
import { listMessages, markMessageRead, type MessageSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface MessagesProps {
  readonly onBack: () => void;
}

export function Messages({ onBack }: MessagesProps) {
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listMessages()
      .then(setMessages)
      .catch(() => setError('消息加载失败'));
  }, []);

  async function read(id: string) {
    try {
      await markMessageRead(id);
      setMessages((current) => current?.map((item) => (
        item.id === id ? { ...item, readAt: new Date().toISOString() } : item
      )) ?? current);
    } catch {
      setError('标记已读失败');
    }
  }

  return (
    <DesignShell
      active="messages"
      eyebrow="Messages"
      title="消息中心"
      subtitle="巡检、审批与事件通知。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      {messages === null ? <p className="muted">加载中…</p> : null}
      {messages?.length === 0 ? (
        <section className="card">
          <div className="card-body empty-state">
            <span className="icon-tile is-blue"><svg><use href="/icons.svg#i-bell" /></svg></span>
            <h3>暂无消息</h3>
            <p className="muted">事件创建和运行时审批会自动生成站内通知。</p>
          </div>
        </section>
      ) : null}
      <section className="grid grid-3">
        {messages?.map((message) => (
          <article key={message.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="badge badge-neutral">{message.severity}</span>
                {message.readAt ? <span className="muted">已读</span> : <span className="badge badge-neutral">未读</span>}
              </div>
              <h3>{message.title}</h3>
              <p className="muted">{message.body}</p>
              {!message.readAt ? (
                <button type="button" className="btn btn-outline" onClick={() => void read(message.id)}>标记已读</button>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
