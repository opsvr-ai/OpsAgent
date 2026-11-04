import { useEffect, useState } from 'react';
import {
  cancelAgentInstructionApproval,
  decideAgentInstructionApproval,
  decideAgentInstructionApprovals,
  decideApproval,
  listAgentInstructionApprovals,
  listApprovalSideEffectFailures,
  listApprovalWebhookDeliveries,
  listApprovals,
  replayApprovalWebhookDelivery,
  type AgentInstructionApproval,
  type ApprovalSideEffectFailure,
  type ApprovalSummary,
  type ApprovalWebhookDelivery,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface ApprovalsProps {
  readonly onBack: () => void;
}

function expiryLabel(value?: string | null): string | null {
  if (!value) return null;
  const remaining = new Date(value).getTime() - Date.now();
  if (remaining <= 0) return '已过期';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes} 分钟后过期`;
  return `${Math.ceil(minutes / 60)} 小时后过期`;
}

export function Approvals({ onBack }: ApprovalsProps) {
  const [approvals, setApprovals] = useState<ApprovalSummary[] | null>(null);
  const [instructionApprovals, setInstructionApprovals] = useState<AgentInstructionApproval[]>([]);
  const [instructionHistory, setInstructionHistory] = useState<AgentInstructionApproval[]>([]);
  const [webhookFailures, setWebhookFailures] = useState<ApprovalWebhookDelivery[]>([]);
  const [sideEffectFailures, setSideEffectFailures] = useState<ApprovalSideEffectFailure[]>([]);
  const [instructionBusy, setInstructionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listApprovals()
      .then(setApprovals)
      .catch(() => setError('审批加载失败'));
    void listAgentInstructionApprovals()
      .then(setInstructionApprovals)
      .catch(() => undefined);
    void listAgentInstructionApprovals('decided')
      .then(setInstructionHistory)
      .catch(() => undefined);
    void listApprovalWebhookDeliveries('failed')
      .then(setWebhookFailures)
      .catch(() => undefined);
    void listApprovalSideEffectFailures()
      .then(setSideEffectFailures)
      .catch(() => undefined);
  }, []);

  async function decideInstruction(id: string, decision: 'approve' | 'deny') {
    setError(null);
    const reason = decision === 'deny' ? window.prompt('拒绝原因（可选）') ?? undefined : undefined;
    try {
      await decideAgentInstructionApproval(id, decision, reason || undefined);
      setInstructionApprovals((current) => current.filter((item) => item.id !== id));
      setInstructionHistory(await listAgentInstructionApprovals('decided'));
    } catch {
      setError('Agent 指令审批失败');
    }
  }

  async function cancelInstruction(id: string) {    setError(null);
    try {
      await cancelAgentInstructionApproval(id);
      setInstructionApprovals((current) => current.filter((item) => item.id !== id));
      setInstructionHistory(await listAgentInstructionApprovals('decided'));
    } catch {
      setError('撤销审批失败，只有请求人可以撤销');
    }
  }

  async function replayDelivery(id: string) {
    setError(null);
    try {
      await replayApprovalWebhookDelivery(id);
      setWebhookFailures(await listApprovalWebhookDeliveries('failed'));
    } catch {
      setError('Webhook 重放失败');
    }
  }

  async function decideAllInstruction(decision: 'approve' | 'deny') {    if (instructionApprovals.length === 0) return;
    setInstructionBusy(true);
    setError(null);
    const reason = decision === 'deny' ? window.prompt('批量拒绝原因（可选）') ?? undefined : undefined;
    try {
      const results = await decideAgentInstructionApprovals(
        instructionApprovals.map((item) => item.id),
        decision,
        reason || undefined,
      );
      const succeeded = new Set(
        results.filter((result) => result.statusCode < 400).map((result) => result.approvalId),
      );
      setInstructionApprovals((current) => current.filter((item) => !succeeded.has(item.id)));
      setInstructionHistory(await listAgentInstructionApprovals('decided'));
      if (results.some((result) => result.statusCode >= 400)) setError('部分审批处理失败');
    } catch {
      setError('批量审批失败');
    } finally {
      setInstructionBusy(false);
    }
  }

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
      <div className="status-strip" style={{ marginBottom: 18 }}>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>待审批</strong><span>{approvals?.length ?? 0} 项</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>R2 只读</strong><span>{approvals?.filter((item) => item.risk === 'R2').length ?? 0} 项</span></div></div>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-bolt" /></svg></span><div><strong>R3 写操作</strong><span>{approvals?.filter((item) => item.risk === 'R3').length ?? 0} 项</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-clock" /></svg></span><div><strong>超时策略</strong><span>批准后继续</span></div></div>
      </div>
      {webhookFailures.length > 0 ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="card-head"><h2>审批 Webhook 投递失败</h2><span className="badge badge-danger">{webhookFailures.length} 条</span></div>
          <div className="card-body">
            <div className="command-history">
              {webhookFailures.map((delivery) => (
                <div key={delivery.id} className="command-row">
                  <span className="mono">{delivery.eventType}</span>
                  <span className="muted">{delivery.lastError ?? '未知错误'}</span>
                  <span className="muted">尝试 {delivery.attempts} 次</span>
                  <span className="muted">{new Date(delivery.createdAt).toLocaleString()}</span>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => void replayDelivery(delivery.id)}>重放</button>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      {sideEffectFailures.length > 0 ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="card-head"><h2>审批副作用失败</h2><span className="badge badge-warn">{sideEffectFailures.length} 条</span></div>
          <div className="card-body">
            <div className="command-history">
              {sideEffectFailures.map((failure) => (
                <div key={failure.id} className="command-row">
                  <span className="mono">{failure.effect}</span>
                  <span className="muted">{failure.error ?? '未知错误'}</span>
                  <span className="muted">{new Date(failure.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      {instructionApprovals.length > 0 ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">
            <h2>Agent 写操作审批</h2>
            <div className="row-sm">
              <span className="badge badge-warn">{instructionApprovals.length} 项</span>
              <button type="button" className="btn btn-primary btn-sm" disabled={instructionBusy} onClick={() => void decideAllInstruction('approve')}>全部批准</button>
              <button type="button" className="btn btn-outline btn-sm" disabled={instructionBusy} onClick={() => void decideAllInstruction('deny')}>全部拒绝</button>
            </div>
          </div>
          <div className="card-body stack">
            {instructionApprovals.map((approval) => (
              <div key={approval.id} className="incident-evidence">
                <div className="row-between">
                  <strong>{approval.hostname} · {approval.service}</strong>
                  <span className="badge badge-neutral">{approval.risk}</span>
                </div>
                <p>{approval.instruction}</p>
                {approval.expiresAt ? <span className="muted">审批到期：{new Date(approval.expiresAt).toLocaleString()}（{expiryLabel(approval.expiresAt)}）</span> : null}
                <div className="row-sm">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void decideInstruction(approval.id, 'approve')}>批准</button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => void decideInstruction(approval.id, 'deny')}>拒绝</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancelInstruction(approval.id)}>撤销</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {instructionHistory.length > 0 ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="card-head"><h2>最近 Agent 指令审批</h2><span className="muted">{instructionHistory.length} 条</span></div>
          <div className="card-body">
            <div className="command-history">
              {instructionHistory.map((approval) => (
                <div key={approval.id} className="command-row">
                  <span className="mono">{approval.hostname}</span>
                  <span>{approval.service ?? approval.action}</span>
                  <span className={`badge ${approval.status === 'approved' ? 'badge-ok' : 'badge-neutral'}`}>{approval.status}</span>
                  <span className="muted">{approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : '—'}</span>
                  {approval.decisionReason ? <span className="muted">原因：{approval.decisionReason}</span> : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      {approvals === null ? <p className="muted">加载中…</p> : null}
      {approvals?.length === 0 ? <p className="muted">暂无待审批</p> : null}
      {approvals?.length === 0 ? (
        <section className="card">
          <div className="card-body empty-state">
            <span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span>
            <h3>没有待审批项</h3>
            <p className="muted">运行时 R2/R3 工具和场景步骤会在这里等待审批。</p>
          </div>
        </section>
      ) : null}
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
                <div className="metric-grid">
                  {Object.entries(approval.details).map(([key, value]) => (
                    <div key={key} className="metric-item">
                      <span>{key}</span>
                      <strong title={String(value)}>{String(value)}</strong>
                    </div>
                  ))}
                </div>
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
