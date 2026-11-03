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
        {shares?.length === 0 ? <p className="muted">暂无共享申请</p> : null}
        <section className="grid grid-3">
          {shares?.map((share) => (
            <article key={share.id} className="card">
              <div className="card-body">
                <div className="scenario-top">
                  <span className="badge badge-neutral">{share.scope}</span>
                  <span className="badge badge-neutral">{share.status}</span>
                </div>
                <h3 className="mono">{share.scenarioId}</h3>
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
