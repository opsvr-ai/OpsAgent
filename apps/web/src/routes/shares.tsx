import { useEffect, useState } from 'react';
import { listShares, reviewShare, type ScenarioShare } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface SharesProps {
  readonly onBack: () => void;
}

export function Shares({ onBack }: SharesProps) {
  const [shares, setShares] = useState<ScenarioShare[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listShares()
      .then(setShares)
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

  return (
    <DesignShell
      active="shares"
      eyebrow="Sharing"
      title="共享审批"
      subtitle="场景跨租户共享申请；审批通过后场景发布到租户目录。"
      onBack={onBack}
    >
        {error ? <p role="alert">{error}</p> : null}
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
        <section className="grid grid-3">
          {shares?.map((share) => (
            <article key={share.id} className="card">
              <div className="card-body">
                <div className="scenario-top">
                  <span className="badge badge-neutral">{share.scope}</span>
                  <span className="badge badge-neutral">{share.status}</span>
                </div>
                <h3 className="mono">{share.scenarioName ?? share.scenarioId}</h3>
              {share.status === 'pending' ? (
                <div className="row-sm">
                  <button type="button" className="btn btn-primary" onClick={() => void review(share.id, 'approve')}>
                    批准
                  </button>
                  <button type="button" className="btn btn-outline" onClick={() => void review(share.id, 'reject')}>
                    拒绝
                  </button>
                </div>
              ) : null}
              </div>
            </article>
          ))}
        </section>
    </DesignShell>
  );
}
