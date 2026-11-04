import { useEffect, useState } from 'react';
import {
  cancelAgentInstructionApproval,
  decideAgentInstructionApproval,
  decideAgentInstructionApprovals,
  decideApproval,
  listAgentInstructionApprovals,
  listApprovalSideEffectFailures,
  listOperationsAlertDeliveries,
  replayOperationsAlertDelivery,
  listApprovalWebhookDeliveries,
  listApprovals,
  listNotificationStats,
  replayApprovalWebhookDelivery,
  resolveApprovalSideEffectFailure,
  type AgentInstructionApproval,
  type ApprovalSideEffectFailure,
  type ApprovalSummary,
  type ApprovalWebhookDelivery,
  type NotificationStatPoint,
  type OperationsAlertDelivery,
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
  const [webhookDelivered, setWebhookDelivered] = useState<ApprovalWebhookDelivery[]>([]);
  const [sideEffectFailures, setSideEffectFailures] = useState<ApprovalSideEffectFailure[]>([]);
  const [operationsAlerts, setOperationsAlerts] = useState<OperationsAlertDelivery[]>([]);
  const [notificationStats, setNotificationStats] = useState<NotificationStatPoint[]>([]);
  const [statsHours, setStatsHours] = useState(24);
  const [chartZoom, setChartZoom] = useState(1);
  const [chartSeries, setChartSeries] = useState({
    approvalDelivered: true,
    approvalFailed: true,
    operationsDelivered: true,
    operationsFailed: true,
  });
  const [instructionBusy, setInstructionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void listApprovals()
        .then((value) => { if (!cancelled) setApprovals(value); })
        .catch(() => { if (!cancelled) setError('审批加载失败'); });
      void listAgentInstructionApprovals()
        .then((value) => { if (!cancelled) setInstructionApprovals(value); })
        .catch(() => undefined);
      void listAgentInstructionApprovals('decided')
        .then((value) => { if (!cancelled) setInstructionHistory(value); })
        .catch(() => undefined);
      void listApprovalWebhookDeliveries('failed')
        .then((value) => { if (!cancelled) setWebhookFailures(value); })
        .catch(() => undefined);
      void listApprovalWebhookDeliveries('delivered')
        .then((value) => { if (!cancelled) setWebhookDelivered(value); })
        .catch(() => undefined);
      void listApprovalSideEffectFailures()
        .then((value) => { if (!cancelled) setSideEffectFailures(value); })
        .catch(() => undefined);
      void listOperationsAlertDeliveries()
        .then((value) => { if (!cancelled) setOperationsAlerts(value); })
        .catch(() => undefined);
      void listNotificationStats(statsHours)
        .then((value) => { if (!cancelled) setNotificationStats(value); })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [statsHours]);

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

  function exportApprovalHistory() {
    if (instructionHistory.length === 0) return;
    const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const rows = [
      ['hostname', 'service', 'action', 'status', 'decidedAt', 'decisionReason'],
      ...instructionHistory.map((item) => [
        item.hostname,
        item.service ?? '',
        item.action,
        item.status,
        item.decidedAt ?? '',
        item.decisionReason ?? '',
      ]),
    ];
    const csv = rows.map((row) => row.map(escape).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `agent-approval-history-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportNotificationStats() {    if (notificationStats.length === 0) return;
    const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const rows = [
      ['hour', 'approvalDelivered', 'approvalFailed', 'operationsDelivered', 'operationsFailed'],
      ...notificationStats.map((point) => [
        point.hour,
        String(point.approvalDelivered),
        String(point.approvalFailed),
        String(point.operationsDelivered),
        String(point.operationsFailed),
      ]),
    ];
    const csv = rows.map((row) => row.map(escape).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `notification-trend-${statsHours}h-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
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

  async function resolveFailure(id: string) {
    setError(null);
    try {
      await resolveApprovalSideEffectFailure(id);
      setSideEffectFailures(await listApprovalSideEffectFailures());
    } catch {
      setError('副作用失败处理失败');
    }
  }

  async function replayOperationsAlert(id: string) {
    setError(null);
    try {
      await replayOperationsAlertDelivery(id);
      setOperationsAlerts(await listOperationsAlertDeliveries());
    } catch {
      setError('运维告警重放失败');
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

  const maxNotification = Math.max(
    1,
    ...notificationStats.flatMap((item) => [
      item.approvalDelivered,
      item.approvalFailed,
      item.operationsDelivered,
      item.operationsFailed,
    ]),
  );
  const chartHeight = 100;
  const chartWidth = Math.max(600, notificationStats.length * 10) * chartZoom;
  const chartLine = (key: keyof Pick<NotificationStatPoint, 'approvalDelivered' | 'approvalFailed' | 'operationsDelivered' | 'operationsFailed'>): string =>
    notificationStats.map((point, index) => {
      const x = notificationStats.length <= 1 ? chartWidth / 2 : (index / (notificationStats.length - 1)) * chartWidth;
      const y = chartHeight - (point[key] / maxNotification) * chartHeight;
      return `${x},${y}`;
    }).join(' ');

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
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-server" /></svg></span><div><strong>Agent 写操作</strong><span>{instructionApprovals.length} 项</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-bolt" /></svg></span><div><strong>Webhook</strong><span>{webhookDelivered.length} 成功 / {webhookFailures.length} 失败</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-alert" /></svg></span><div><strong>运维告警</strong><span>{operationsAlerts.filter((item) => item.status === 'failed').length} 失败</span></div></div>
      </div>
      {notificationStats.length > 0 ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">
            <h2>{statsHours === 168 ? '最近 7 天通知趋势' : `最近 ${statsHours} 小时通知趋势`}</h2>
            <div className="row-sm">
              {[1, 12, 24, 72, 168].map((hours) => (
                <button
                  key={hours}
                  type="button"
                  className={`btn btn-sm ${statsHours === hours ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setStatsHours(hours)}
                >
                  {hours === 168 ? '7 天' : `${hours}h`}
                </button>
              ))}
              <button type="button" className="btn btn-outline btn-sm" onClick={exportNotificationStats}>导出 CSV</button>
              <span className="muted">{statsHours > 72 ? '按天聚合' : '按小时聚合'}</span>
              {[1, 2, 4].map((zoom) => (
                <button
                  key={zoom}
                  type="button"
                  className={`btn btn-sm ${chartZoom === zoom ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setChartZoom(zoom)}
                >
                  {zoom}x
                </button>
              ))}
            </div>
          </div>
          <div className="card-body">
            <div style={{ overflowX: 'auto', marginBottom: 8 }}>
            <svg viewBox={`0 0 ${chartWidth} 100`} preserveAspectRatio="none" style={{ width: chartWidth, height: 100, display: 'block' }}>
              <polyline fill="none" stroke="var(--ok)" strokeWidth="1.5" points={chartLine('approvalDelivered')} style={{ display: chartSeries.approvalDelivered ? undefined : 'none' }} />
              <polyline fill="none" stroke="var(--danger)" strokeWidth="1.5" points={chartLine('approvalFailed')} style={{ display: chartSeries.approvalFailed ? undefined : 'none' }} />
              <polyline fill="none" stroke="var(--accent)" strokeWidth="1.5" points={chartLine('operationsDelivered')} style={{ display: chartSeries.operationsDelivered ? undefined : 'none' }} />
              <polyline fill="none" stroke="var(--warn)" strokeWidth="1.5" points={chartLine('operationsFailed')} style={{ display: chartSeries.operationsFailed ? undefined : 'none' }} />
              {notificationStats.map((point, index) => {
                const x = notificationStats.length <= 1 ? chartWidth / 2 : (index / (notificationStats.length - 1)) * chartWidth;
                const y = chartHeight - (point.approvalDelivered / maxNotification) * chartHeight;
                return (
                  <circle key={`${point.hour}-point`} cx={x} cy={y} r={3} fill="var(--ok)" opacity={0.8}>
                    <title>
                      {new Date(point.hour).toLocaleString()} · 审批 {point.approvalDelivered} 成功 / {point.approvalFailed} 失败 · 运维 {point.operationsDelivered} 成功 / {point.operationsFailed} 失败
                    </title>
                  </circle>
                );
              })}
            </svg>
            </div>
            <div className="row-sm" style={{ marginBottom: 8 }}>
              <button type="button" className={`badge ${chartSeries.approvalDelivered ? 'badge-ok' : 'badge-neutral'}`} onClick={() => setChartSeries((current) => ({ ...current, approvalDelivered: !current.approvalDelivered }))}>审批成功</button>
              <button type="button" className={`badge ${chartSeries.approvalFailed ? 'badge-danger' : 'badge-neutral'}`} onClick={() => setChartSeries((current) => ({ ...current, approvalFailed: !current.approvalFailed }))}>审批失败</button>
              <button type="button" className={`badge ${chartSeries.operationsDelivered ? 'badge-neutral' : 'badge-neutral'}`} onClick={() => setChartSeries((current) => ({ ...current, operationsDelivered: !current.operationsDelivered }))}>运维成功</button>
              <button type="button" className={`badge ${chartSeries.operationsFailed ? 'badge-warn' : 'badge-neutral'}`} onClick={() => setChartSeries((current) => ({ ...current, operationsFailed: !current.operationsFailed }))}>运维失败</button>
            </div>
            <div className="command-history">
              {notificationStats.map((point) => (
                <div key={point.hour} className="command-row">
                  <span className="mono">{statsHours > 72 ? new Date(point.hour).toLocaleDateString() : new Date(point.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="muted">审批 {point.approvalDelivered} 成功 / {point.approvalFailed} 失败</span>
                  <span className="muted">运维 {point.operationsDelivered} 成功 / {point.operationsFailed} 失败</span>
                  <div style={{ display: 'flex', gap: 2, flex: 1, height: 6 }}>
                    <div style={{ width: `${(point.approvalDelivered / maxNotification) * 100}%`, background: 'var(--ok)' }} />
                    <div style={{ width: `${(point.approvalFailed / maxNotification) * 100}%`, background: 'var(--danger)' }} />
                    <div style={{ width: `${(point.operationsDelivered / maxNotification) * 100}%`, background: 'var(--accent)' }} />
                    <div style={{ width: `${(point.operationsFailed / maxNotification) * 100}%`, background: 'var(--warn)' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
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
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => void resolveFailure(failure.id)}>标记已处理</button>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      {operationsAlerts.length > 0 ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="card-head"><h2>运维告警投递</h2><span className="muted">{operationsAlerts.length} 条</span></div>
          <div className="card-body">
            <div className="command-history">
              {operationsAlerts.map((delivery) => (
                <div key={delivery.id} className="command-row">
                  <span>{delivery.title}</span>
                  <span className={`badge ${delivery.status === 'failed' ? 'badge-danger' : 'badge-neutral'}`}>{delivery.status}</span>
                  <span className="muted">{delivery.lastError ?? `尝试 ${delivery.attempts} 次`}</span>
                  <span className="muted">{new Date(delivery.createdAt).toLocaleString()}</span>
                  {delivery.status === 'failed' ? <button type="button" className="btn btn-outline btn-sm" onClick={() => void replayOperationsAlert(delivery.id)}>重放</button> : null}
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
          <div className="card-head"><h2>最近 Agent 指令审批</h2><div className="row-sm"><span className="muted">{instructionHistory.length} 条</span><button type="button" className="btn btn-outline btn-sm" onClick={exportApprovalHistory}>导出 CSV</button></div></div>
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
