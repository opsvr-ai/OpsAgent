import { useEffect, useState } from 'react';
import { listShares, reviewShare, type ScenarioShare } from '../api/client.js';

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
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">OpsAgent</div>
        <div className="tenant">
          <strong>共享审批</strong>
          <span>场景共享申请</span>
        </div>
        <button type="button" onClick={onBack}>返回工作台</button>
      </aside>
      <main className="page">
        <header>
          <div className="eyebrow">Sharing</div>
          <h1>共享审批</h1>
        </header>
        {error ? <p role="alert">{error}</p> : null}
        {shares === null ? <p className="muted">加载中…</p> : null}
        {shares?.length === 0 ? <p className="muted">暂无共享申请</p> : null}
        <section className="cards">
          {shares?.map((share) => (
            <article key={share.id} className="card">
              <h2>{share.scenarioId}</h2>
              <p className="muted">{share.scope} · {share.status}</p>
              {share.status === 'pending' ? (
                <div>
                  <button type="button" onClick={() => void review(share.id, 'approve')}>
                    批准
                  </button>
                  <button type="button" onClick={() => void review(share.id, 'reject')}>
                    拒绝
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
