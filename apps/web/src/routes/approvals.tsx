import { useEffect, useState } from 'react';
import { decideApproval, listApprovals, type ApprovalSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface ApprovalsProps {
  readonly onBack: () => void;
}

export function Approvals({ onBack }: ApprovalsProps) {
  const [approvals, setApprovals] = useState<ApprovalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listApprovals()
      .then(setApprovals)
      .catch(() => setError('审批加载失败'));
  }, []);

  async function decide(id: string, decision: 'approve' | 'deny') {
    setError(null);
    try {
      await decideApproval(id, decision);
      setApprovals((current) => current?.filter((item) => item.id !== id) ?? current);
    } catch {
      setError('审批失败');
    }
  }

  return (
    <DesignShell
      active="approvals"
      eyebrow="Approvals"
      title="待审批"
      subtitle="运行时工具调用的 R2/R3 审批；批准后真实 dsh 会话继续执行。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      {approvals === null ? <p className="muted">加载中…</p> : null}
      {approvals?.length === 0 ? <p className="muted">暂无待审批</p> : null}
      <section className="grid grid-3">
        {approvals?.map((approval) => (
          <article key={approval.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="badge badge-neutral">{approval.risk}</span>
                <span className="muted">{approval.sessionId.slice(0, 12)}</span>
              </div>
              <h3>{approval.action}</h3>
              {Object.keys(approval.details).length > 0 ? (
                <pre className="code-block">{JSON.stringify(approval.details, null, 2)}</pre>
              ) : null}
              <div className="row-sm">
                <button type="button" className="btn btn-primary" onClick={() => void decide(approval.id, 'approve')}>批准</button>
                <button type="button" className="btn btn-outline" onClick={() => void decide(approval.id, 'deny')}>拒绝</button>
              </div>
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
