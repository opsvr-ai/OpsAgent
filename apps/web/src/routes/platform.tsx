import { useEffect, useState } from 'react';
import {
  createPlatformTenant,
  listPlatformTenants,
  type PlatformTenant,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface PlatformProps {
  readonly onRefresh: () => void;
}

export function Platform({ onRefresh }: PlatformProps) {
  const [tenants, setTenants] = useState<PlatformTenant[] | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listPlatformTenants()
      .then(setTenants)
      .catch(() => setError('租户加载失败'));
  }, []);

  async function create() {
    if (!name.trim() || !slug.trim()) {
      setError('请填写名称和 slug');
      return;
    }
    setError(null);
    try {
      const tenant = await createPlatformTenant({ name: name.trim(), slug: slug.trim() });
      setTenants((current) => [tenant, ...(current ?? [])]);
      setName('');
      setSlug('');
    } catch {
      setError('创建租户失败');
    }
  }

  const activeTenants = tenants?.filter((tenant) => tenant.status === 'active').length ?? 0;

  return (
    <DesignShell
      active="home"
      eyebrow="Platform"
      title="平台租户管理"
      subtitle="平台管理员治理租户；不读取租户会话正文。"
      onBack={onRefresh}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="status-strip" style={{ marginBottom: 20 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-building" /></svg></span><div><strong>租户</strong><span>{tenants?.length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已激活</strong><span>{activeTenants} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>待激活</strong><span>{Math.max(0, (tenants?.length ?? 0) - activeTenants)} 个</span></div></div>
      </div>
      <section className="card">
        <div className="card-head"><h2>新建租户</h2><span className="muted">平台级操作</span></div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="tenant-name">名称</label>
              <input id="tenant-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 星河银行" />
            </div>
            <div className="field">
              <label htmlFor="tenant-slug">Slug</label>
              <input id="tenant-slug" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="例如 bank-demo" />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void create()}>创建租户</button>
          </div>
        </div>
      </section>
      {tenants === null ? <p className="muted">加载中…</p> : null}
      <section className="card">
        <div className="card-head"><h2>租户</h2><span className="muted">{tenants?.length ?? 0} 个</span></div>
        <div className="card-body">
          {tenants && tenants.length > 0 ? (
            <table className="table">
              <thead><tr><th>租户</th><th>Slug</th><th>状态</th><th>ID</th></tr></thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr key={tenant.id}>
                    <td className="cell-main">{tenant.name}</td>
                    <td className="mono">{tenant.slug}</td>
                    <td><span className="badge badge-neutral">{tenant.status}</span></td>
                    <td className="mono">{tenant.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">暂无租户</p>}
        </div>
      </section>
    </DesignShell>
  );
}
