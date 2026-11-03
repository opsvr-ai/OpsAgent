import { useEffect, useState } from 'react';
import {
  createKnowledge,
  listKnowledge,
  publishKnowledge,
  type KnowledgeDocument,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface KnowledgeProps {
  readonly onBack: () => void;
}

export function Knowledge({ onBack }: KnowledgeProps) {
  const [documents, setDocuments] = useState<KnowledgeDocument[] | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function search(value = query) {
    setError(null);
    try {
      setDocuments(await listKnowledge(value.trim() || undefined));
    } catch {
      setError('知识库加载失败');
    }
  }

  useEffect(() => {
    void search('');
  }, []);

  async function create() {
    if (!title.trim() || !body.trim()) {
      setError('请填写标题和内容');
      return;
    }
    setError(null);
    try {
      const document = await createKnowledge({ title: title.trim(), body: body.trim() });
      setDocuments((current) => [document, ...(current ?? [])]);
      setTitle('');
      setBody('');
    } catch {
      setError('创建失败');
    }
  }

  async function publish(id: string) {
    setError(null);
    try {
      const updated = await publishKnowledge(id);
      setDocuments((current) => current?.map((item) => (item.id === id ? updated : item)) ?? current);
    } catch {
      setError('发布失败');
    }
  }

  return (
    <DesignShell
      active="knowledge"
      eyebrow="Knowledge"
      title="知识中心"
      subtitle="运维知识、排障经验与审核发布。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <section className="card">
        <div className="card-head"><h2>新建知识</h2><span className="muted">发布前可审核</span></div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="knowledge-title">标题</label>
              <input id="knowledge-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 MySQL 连接池排障" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="knowledge-body">内容</label>
              <textarea id="knowledge-body" rows={5} value={body} onChange={(event) => setBody(event.target.value)} placeholder="记录现象、排查步骤、根因与处置方案" />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void create()}>创建知识</button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-body">
          <div className="row-sm">
            <label htmlFor="knowledge-search">搜索</label>
            <input
              id="knowledge-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
              placeholder="按标题或内容搜索"
            />
            <button type="button" className="btn btn-outline" onClick={() => void search()}>搜索</button>
          </div>
        </div>
      </section>

      {documents === null ? <p className="muted">加载中…</p> : null}
      {documents?.length === 0 ? <p className="muted">暂无知识</p> : null}
      <section className="grid grid-3">
        {documents?.map((document) => (
          <article key={document.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="badge badge-neutral">{document.status}</span>
              </div>
              <h3>{document.title}</h3>
              <p className="muted">{document.body}</p>
              {document.status !== 'published' ? (
                <button type="button" className="btn btn-outline" onClick={() => void publish(document.id)}>发布</button>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
