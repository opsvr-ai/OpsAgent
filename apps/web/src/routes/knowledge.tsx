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

const SOURCES = [
  { title: '插件数据', description: '知识智能体从 Zabbix、Prometheus、CMDB 抽取巡检与事件证据。', badge: '自动', icon: 'database' },
  { title: '知识文档', description: 'PDF / Word / Excel / Markdown / HTML，解析后入库。', badge: '已解析', icon: 'book' },
  { title: '用户对话', description: '用户显式确认后有选择地沉淀，默认不采集。', badge: '租户开启', icon: 'message' },
  { title: '平台运行', description: '巡检、场景、事件与智能体产物中的高价值结论。', badge: '自动', icon: 'activity' },
];

export function Knowledge({ onBack }: KnowledgeProps) {
  const [documents, setDocuments] = useState<KnowledgeDocument[] | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<'all' | 'published' | 'draft'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function search(value = query) {
    setError(null);
    try {
      const items = await listKnowledge(value.trim() || undefined);
      setDocuments(items);
      setSelectedId((current) => current ?? items[0]?.id ?? null);
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
      setSelectedId(document.id);
      setTitle('');
      setBody('');
      setShowCreate(false);
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

  const published = documents?.filter((item) => item.status === 'published').length ?? 0;
  const drafts = documents?.filter((item) => item.status !== 'published').length ?? 0;
  const rows = (documents ?? []).filter((item) => tab === 'all' || (tab === 'published' ? item.status === 'published' : item.status !== 'published'));
  const selected = documents?.find((item) => item.id === selectedId) ?? null;

  return (
    <DesignShell
      active="knowledge"
      eyebrow="Knowledge base · 租户内共享 · 知识管理员"
      title="知识中心"
      subtitle="把会话、事件、巡检和变更中的证据加工成可复用的运维知识。自动沉淀只生成草稿，发布和变更必须经知识管理员确认。"
      onBack={onBack}
      actions={
        <>
          <button type="button" className="btn btn-outline" onClick={() => void search()}>导入文档</button>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate((current) => !current)}>新建知识</button>
        </>
      }
    >
      {error ? <p role="alert">{error}</p> : null}

      <div className="status-strip" style={{ marginBottom: 20 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-book" /></svg></span><div><strong>已发布</strong><span>{published} 条</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>待审核</strong><span>{drafts} 条</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-grid" /></svg></span><div><strong>知识总数</strong><span>{documents?.length ?? 0} 条</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>来源</strong><span>4 类证据</span></div></div>
      </div>

      <section className="grid grid-4" style={{ marginBottom: 20 }}>
        {SOURCES.map((source) => (
          <article key={source.title} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="icon-tile is-blue"><svg><use href={`/icons.svg#i-${source.icon}`} /></svg></span>
                <span className="badge badge-neutral">{source.badge}</span>
              </div>
              <h3>{source.title}</h3>
              <p className="muted">{source.description}</p>
            </div>
          </article>
        ))}
      </section>

      {showCreate ? (
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
      ) : null}

      <div className="tabs" style={{ marginBottom: 14 }}>
        <button type="button" className={`tab${tab === 'all' ? ' is-active' : ''}`} onClick={() => setTab('all')}>全部<span className="count">{documents?.length ?? 0}</span></button>
        <button type="button" className={`tab${tab === 'published' ? ' is-active' : ''}`} onClick={() => setTab('published')}>已发布<span className="count">{published}</span></button>
        <button type="button" className={`tab${tab === 'draft' ? ' is-active' : ''}`} onClick={() => setTab('draft')}>待审核<span className="count">{drafts}</span></button>
        <input
          className="input tab-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
          placeholder="搜索知识、来源、标签"
          aria-label="搜索知识"
        />
      </div>

      {documents === null ? <p className="muted">加载中…</p> : null}
      {documents?.length === 0 ? <p className="muted">暂无知识</p> : null}

      {documents && documents.length > 0 ? (
        <div className="knowledge-layout">
          <section className="card">
            <div className="card-head"><h2>运维知识库</h2><span className="badge badge-neutral">{rows.length} 条</span></div>
            <div className="card-body">
              <table className="table">
                <thead><tr><th>知识</th><th>状态</th><th /></tr></thead>
                <tbody>
                  {rows.map((document) => (
                    <tr key={document.id} className="is-clickable" onClick={() => setSelectedId(document.id)}>
                      <td className="cell-main">{document.title}</td>
                      <td><span className={`badge ${document.status === 'published' ? 'badge-ok' : 'badge-warn'}`}>{document.status}</span></td>
                      <td className="actions-cell">
                        {document.status !== 'published' ? (
                          <button type="button" className="btn btn-outline btn-sm" onClick={(event) => { event.stopPropagation(); void publish(document.id); }}>发布</button>
                        ) : <button type="button" className="btn btn-ghost btn-sm">查看</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="stack">
            <section className="card">
              <div className="card-head"><h2>审核详情</h2>{selected ? <span className="badge badge-neutral">{selected.status}</span> : null}</div>
              <div className="card-body">
                {selected ? (
                  <>
                    <h3>{selected.title}</h3>
                    <p style={{ lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{selected.body}</p>
                    <div className="aside-row"><span>知识 ID</span><span className="mono">{selected.id.slice(0, 12)}</span></div>
                    <div className="aside-row"><span>来源</span><span>平台运行</span></div>
                    <div className="aside-row"><span>状态</span><span>{selected.status}</span></div>
                    {selected.status !== 'published' ? (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void publish(selected.id)}>发布知识</button>
                    ) : null}
                  </>
                ) : <p className="muted">选择一条知识</p>}
              </div>
            </section>
          </aside>
        </div>
      ) : null}
    </DesignShell>
  );
}
