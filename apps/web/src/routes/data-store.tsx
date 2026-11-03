import { useEffect, useState } from 'react';
import {
  cleanupDataStore,
  getDataStore,
  getDataStoreSettings,
  saveDataStoreSettings,
  type DataStoreSettings,
  type DataStoreStats,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';
import { relativeTime } from '../format.js';

export interface DataStoreProps {
  readonly onBack: () => void;
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function DataStore({ onBack }: DataStoreProps) {
  const [stats, setStats] = useState<DataStoreStats | null>(null);
  const [settings, setSettings] = useState<DataStoreSettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setError(null);
    try {
      const [nextStats, nextSettings] = await Promise.all([getDataStore(), getDataStoreSettings()]);
      setStats(nextStats);
      setSettings(nextSettings);
    } catch {
      setError('数据存储加载失败');
    }
  }

  async function saveSettings() {
    if (!settings) return;
    setError(null);
    try {
      setSettings(await saveDataStoreSettings(settings));
      setMessage('同步设置已保存');
    } catch {
      setError('同步设置保存失败');
    }
  }

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
      actions={<button type="button" className="btn btn-primary" onClick={() => void refresh()}>刷新数据</button>}
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
            <p className="muted mono">{formatBytes(stats?.bytes ?? 0)} / {formatBytes(stats?.quotaBytes ?? 0)}</p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="eyebrow">最新同步</div>
            <h3 className="mono">{relativeTime(stats?.newest)}</h3>
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
                    <td>{formatBytes(item.bytes)}</td>
                    <td className="mono">{relativeTime(item.lastSync)}</td>
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
          <h2>同步与回源</h2>
          {settings ? (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="data-priority">查询优先策略</label>
                <select
                  id="data-priority"
                  value={settings.priority}
                  onChange={(event) => setSettings({ ...settings, priority: event.target.value })}
                >
                  <option value="local-first">本地优先</option>
                  <option value="live-first">实时优先</option>
                  <option value="local-only">仅本地</option>
                  <option value="live-only">仅实时</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="data-sync">同步周期</label>
                <select
                  id="data-sync"
                  value={settings.syncInterval}
                  onChange={(event) => setSettings({ ...settings, syncInterval: event.target.value })}
                >
                  <option value="5m">增量，每 5 分钟</option>
                  <option value="10m">增量，每 10 分钟</option>
                  <option value="1h">增量，每小时</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="data-full-sync">全量对账时间</label>
                <input
                  id="data-full-sync"
                  value={settings.fullSyncAt}
                  onChange={(event) => setSettings({ ...settings, fullSyncAt: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="data-freshness">新鲜度阈值（秒）</label>
                <input
                  id="data-freshness"
                  type="number"
                  value={settings.freshnessSec}
                  onChange={(event) =>
                    setSettings({ ...settings, freshnessSec: Number(event.target.value) })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="data-retention">保留天数</label>
                <input
                  id="data-retention"
                  type="number"
                  value={settings.retentionDays}
                  onChange={(event) =>
                    setSettings({ ...settings, retentionDays: Number(event.target.value) })
                  }
                />
              </div>
            </div>
          ) : null}
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void saveSettings()}>保存设置</button>
          </div>
        </div>
      </section>
      <section className="card">
        <div className="card-body">
          <h2>最近同步</h2>
          {stats?.recent.length === 0 ? <p className="muted">暂无快照</p> : null}
          {stats?.recent.map((item) => (
            <div key={item.id} className="row-between">
              <span className="mono">{item.tool}</span>
              <span className="muted">{formatBytes(item.bytes)}</span>
              <span className="muted mono">{relativeTime(item.createdAt)}</span>
            </div>
          ))}
        </div>
      </section>
    </DesignShell>
  );
}
