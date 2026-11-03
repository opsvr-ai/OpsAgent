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
      <section className="grid grid-4">
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">本地数据集</div>
            <h3>{stats?.datasets?.length ?? 0} 个数据集</h3>
            <p className="muted mono">{stats?.count ?? 0} 条快照</p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">存储占用</div>
            <h3>{stats?.usagePct ?? 0}%</h3>
            <p className="muted mono">{(stats?.bytes ?? 0)} / {(stats?.quotaBytes ?? 0)} bytes</p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">最新同步</div>
            <h3 className="mono">{stats?.newest ?? '暂无'}</h3>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">保留与自动清理</div>
            <h3>30 天</h3>
            <button type="button" className="btn btn-outline" onClick={() => void dryRun()}>清理 dry-run</button>
          </div>
        </article>
      </section>
      <section className="card">
        <div className="card-body">
          <div className="row-between">
            <h2>数据集</h2>
            <span className="muted">按能力聚合</span>
          </div>
          {stats?.datasets?.length === 0 ? <p className="muted">暂无数据集</p> : null}
          {stats?.datasets && stats.datasets.length > 0 ? (
            <table className="table">
              <thead>
                <tr><th>数据集</th><th>快照数</th><th>大小</th><th>最后同步</th><th>保留</th></tr>
              </thead>
              <tbody>
                {stats.datasets.map((item) => (
                  <tr key={item.tool}>
                    <td className="mono">{item.tool}</td>
                    <td>{item.count}</td>
                    <td>{item.bytes} bytes</td>
                    <td className="mono">{item.lastSync ?? '暂无'}</td>
                    <td>30 天</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
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
