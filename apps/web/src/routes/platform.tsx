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

  return (
    <DesignShell
      active="home"
      eyebrow="Platform"
      title="平台租户管理"
      subtitle="平台管理员治理租户；不读取租户会话正文。"
      onBack={onRefresh}
    >
      {error ? <p role="alert">{error}</p> : null}
      <section className="card">
        <div className="card-body">
          <h2>新建租户</h2>
          <label htmlFor="tenant-name">名称</label>
          <input id="tenant-name" value={name} onChange={(event) => setName(event.target.value)} />
          <label htmlFor="tenant-slug">Slug</label>
          <input id="tenant-slug" value={slug} onChange={(event) => setSlug(event.target.value)} />
          <button type="button" className="btn btn-primary" onClick={() => void create()}>创建租户</button>
        </div>
      </section>
      {tenants === null ? <p className="muted">加载中…</p> : null}
      <section className="grid grid-3">
        {tenants?.map((tenant) => (
          <article key={tenant.id} className="card">
            <div className="card-body">
              <span className="badge badge-neutral">{tenant.status}</span>
              <h3>{tenant.name}</h3>
              <p className="muted mono">{tenant.slug}</p>
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
