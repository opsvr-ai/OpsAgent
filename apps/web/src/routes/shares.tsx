import { useEffect, useState } from 'react';
import { listShares, reviewShare, type ScenarioShare } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface SharesProps {
  readonly onBack: () => void;
}

export function Shares({ onBack }: SharesProps) {
  const [shares, setShares] = useState<ScenarioShare[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listShares()
      .then((items) => {
        setShares(items);
        setSelectedId(items[0]?.id ?? null);
      })
      .catch(() => setError('共享申请加载失败'));
  }, []);

  async function review(id: string, decision: 'approve' | 'reject') {
    setError(null);
    try {
      const updated = await reviewShare(id, decision);
      setShares((current) =>
        current?.map((share) => (share.id === id ? updated : share)) ?? current,
      );
    } catch {
      setError('审批失败');
    }
  }

  const pending = shares?.filter((share) => share.status === 'pending').length ?? 0;
  const approved = shares?.filter((share) => share.status === 'approved').length ?? 0;
  const rejected = shares?.filter((share) => share.status === 'rejected').length ?? 0;
  const rows = (shares ?? []).filter((share) => filter === 'all' || share.status === 'pending');
  const selected = shares?.find((share) => share.id === selectedId) ?? null;

  return (
    <DesignShell
      active="shares"
      eyebrow="Share governance · 租户管理员审批"
      title="共享审批"
      subtitle="场景与连接器默认只在租户内可用；发布到租户目录或平台共享池需要租户管理员审批。"
      onBack={onBack}
      actions={<button type="button" className="btn btn-outline" onClick={() => setFilter((current) => (current === 'pending' ? 'all' : 'pending'))}>{filter === 'pending' ? '查看全部' : '仅看待审批'}</button>}
    >
      {error ? <p role="alert">{error}</p> : null}

      <div className="status-strip" style={{ marginBottom: 20 }}>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>待审批</strong><span>{pending} 项</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已批准</strong><span>{approved} 项</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-share" /></svg></span><div><strong>共享池</strong><span>{approved} 个可用场景</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>已拒绝</strong><span>{rejected} 项</span></div></div>
      </div>

      <div className="tabs" style={{ marginBottom: 14 }}>
        <button type="button" className={`tab${filter === 'pending' ? ' is-active' : ''}`} onClick={() => setFilter('pending')}>待审批<span className="count">{pending}</span></button>
        <button type="button" className={`tab${filter === 'all' ? ' is-active' : ''}`} onClick={() => setFilter('all')}>全部<span className="count">{shares?.length ?? 0}</span></button>
      </div>

      {shares === null ? <p className="muted">加载中…</p> : null}
      {shares?.length === 0 ? (
        <section className="card">
          <div className="card-body empty-state">
            <span className="icon-tile is-blue"><svg><use href="/icons.svg#i-share" /></svg></span>
            <h3>暂无共享申请</h3>
            <p className="muted">场景发起跨租户共享后会出现在这里。</p>
          </div>
        </section>
      ) : null}

      {shares && shares.length > 0 ? (
        <div className="share-layout">
          <section className="card">
            <div className="card-head"><h2>申请队列</h2><span className="muted">{rows.length}</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              {rows.length === 0 ? <p className="muted" style={{ padding: 12 }}>没有符合条件的申请</p> : null}
              {rows.map((share) => (
                <button
                  key={share.id}
                  type="button"
                  className={`inbox-item${share.id === selectedId ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(share.id)}
                >
                  <span className={`badge ${share.status === 'pending' ? 'badge-warn' : 'badge-ok'}`}>{share.status}</span>
                  <span className="grow">
                    <strong>{share.scenarioName ?? share.scenarioId}</strong>
                    <span>{share.scope === 'platform' ? '平台共享池' : '租户目录'} · 需要审批</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>申请详情</h2>
              {selected ? <span className={`badge ${selected.status === 'pending' ? 'badge-warn' : 'badge-ok'}`}>{selected.status}</span> : null}
            </div>
            <div className="card-body">
              {selected ? (
                <>
                  <h3>{selected.scenarioName ?? selected.scenarioId}</h3>
                  <div className="aside-row"><span>共享范围</span><span>{selected.scope === 'platform' ? '平台共享池' : '租户目录'}</span></div>
                  <div className="aside-row"><span>申请人</span><span className="mono">{selected.requestedBy}</span></div>
                  <div className="aside-row"><span>申请原因</span><span>{selected.reason ?? '未填写'}</span></div>
                  <div className="aside-row"><span>审批人</span><span>{selected.reviewerId ?? '待分配'}</span></div>
                  <div className="aside-row"><span>场景 ID</span><span className="mono">{selected.scenarioId}</span></div>
                  <div className="card" style={{ marginTop: 14 }}>
                    <div className="card-body">
                      <strong>审批边界</strong>
                      <p className="muted">批准后只把场景定义发布到共享目录，不共享运行结果、凭据或租户会话正文。</p>
                    </div>
                  </div>
                  {selected.status === 'pending' ? (
                    <div className="row-sm" style={{ marginTop: 14 }}>
                      <button type="button" className="btn btn-primary" onClick={() => void review(selected.id, 'approve')}>批准</button>
                      <button type="button" className="btn btn-outline" onClick={() => void review(selected.id, 'reject')}>拒绝</button>
                    </div>
                  ) : null}
                </>
              ) : <p className="muted">选择一条申请</p>}
            </div>
          </section>
        </div>
      ) : null}
    </DesignShell>
  );
}
