import { useEffect, useState } from 'react';
import { listMessages, markMessageRead, type MessageSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface MessagesProps {
  readonly onBack: () => void;
}

export function Messages({ onBack }: MessagesProps) {
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listMessages()
      .then((items) => {
        setMessages(items);
        setSelectedId(items[0]?.id ?? null);
      })
      .catch(() => setError('消息加载失败'));
  }, []);

  const selected = messages?.find((item) => item.id === selectedId) ?? null;
  const unread = messages?.filter((item) => !item.readAt).length ?? 0;

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
      {messages && messages.length > 0 ? (
        <div className="split-grid">
          <section className="card">
            <div className="card-head">
              <h2>收件箱</h2>
              <span className={unread > 0 ? 'badge badge-warn' : 'badge badge-ok'}>{unread} 未读</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {messages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  className={`inbox-item${message.id === selectedId ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(message.id)}
                >
                  <span className={`dot ${message.readAt ? '' : 'dot-warn'}`} />
                  <span className="grow">
                    <strong>{message.title}</strong>
                    <span>{message.body}</span>
                  </span>
                  <span className="badge badge-neutral">{message.severity}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="card">
            <div className="card-head">
              <h2>{selected?.title ?? '消息详情'}</h2>
              {selected ? <span className="badge badge-neutral">{selected.severity}</span> : null}
            </div>
            <div className="card-body">
              {selected ? (
                <>
                  <div className="aside-row"><span>时间</span><span className="mono">{selected.createdAt}</span></div>
                  <div className="aside-row"><span>状态</span><span>{selected.readAt ? '已读' : '未读'}</span></div>
                  <p style={{ marginTop: 16, lineHeight: 1.7 }}>{selected.body}</p>
                  {!selected.readAt ? (
                    <button type="button" className="btn btn-outline" onClick={() => void read(selected.id)}>标记已读</button>
                  ) : null}
                </>
              ) : <p className="muted">选择一条消息</p>}
            </div>
          </section>
          <section className="card split-side">
            <div className="card-head"><h2>渠道与路由</h2></div>
            <div className="card-body">
              <p className="muted">站内消息已启用。</p>
              <p className="muted">Webhook 由 `OPSAGENT_WEBHOOK_URL` 配置；未配置时只落站内。</p>
            </div>
          </section>
        </div>
      ) : null}
    </DesignShell>
  );
}
