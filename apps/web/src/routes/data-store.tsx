import { useEffect, useState } from 'react';
import {
  cleanupDataStore,
  getDataStore,
  type DataStoreStats,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface DataStoreProps {
  readonly onBack: () => void;
}

export function DataStore({ onBack }: DataStoreProps) {
  const [stats, setStats] = useState<DataStoreStats | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getDataStore()
      .then(setStats)
      .catch(() => setError('数据存储加载失败'));
  }, []);

  async function dryRun() {
    setError(null);
    try {
      const result = await cleanupDataStore(30, true);
      setMessage(`dry-run：${result.count} 条 / ${result.bytes} bytes`);
    } catch {
      setError('清理预览失败');
    }
  }

  return (
    <DesignShell
      active="data"
      eyebrow="Data"
      title="插件数据沉淀"
      subtitle="本地快照、同步与回源、保留策略和配额。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}
      {stats === null ? <p className="muted">加载中…</p> : null}
      <section className="grid grid-3">
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">数据集</div>
            <h3>{stats?.count ?? 0} 条快照</h3>
            <p className="muted mono">{stats?.bytes ?? 0} bytes</p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">保留与自动清理</div>
            <h3>30 天</h3>
            <button type="button" className="btn btn-outline" onClick={() => void dryRun()}>清理 dry-run</button>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">同步窗口</div>
            <p className="muted">最新：{stats?.newest ?? '暂无'}</p>
            <p className="muted">最早：{stats?.oldest ?? '暂无'}</p>
          </div>
        </article>
      </section>
      <section className="card">
        <div className="card-body">
          <h2>最近同步</h2>
          {stats?.recent.length === 0 ? <p className="muted">暂无快照</p> : null}
          {stats?.recent.map((item) => (
            <div key={item.id} className="row-between">
              <span className="mono">{item.tool}</span>
              <span className="muted">{item.bytes} bytes</span>
              <span className="muted mono">{item.createdAt}</span>
            </div>
          ))}
        </div>
      </section>
    </DesignShell>
  );
}
