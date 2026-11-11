import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { TopologyAdjustOperation, TopologyAdjustment } from '@opsagent/contracts';
import { relativeTime } from '../format.js';
import { operationLabel } from './adjustments.js';
import { MiniIcon } from './icons.js';

function warningLabel(value: string): string {
  if (!value.startsWith('rule_fallback:')) return value;
  const detail = value.slice('rule_fallback:'.length).trim();
  return `模型暂不可用或返回异常（${detail || 'unknown'}），已用本地规则解析`;
}

export interface AdjustFeedback {
  readonly reply: string;
  readonly operations: readonly TopologyAdjustOperation[];
  readonly model: string;
  readonly fallback: boolean;
  readonly warning?: string;
  readonly clarification?: string;
  readonly error?: string;
}

export interface AdjustmentPanelProps {
  readonly open: boolean;
  readonly graphId: string | null;
  readonly history: readonly TopologyAdjustment[];
  readonly value: string;
  readonly sending: boolean;
  readonly feedback: AdjustFeedback | null;
  readonly undoBusy: boolean;
  readonly onValueChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onUndo: () => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}

const EXAMPLES = [
  '隐藏外部依赖',
  '只看 prod-db-01',
  '把 prod-db-01 改名为 订单数据库',
  '把 gateway-order-01 改到数据层',
  '给 gateway-order-01→prod-web-01:443 打标签：核心入口',
  '重置视图',
];

export function AdjustmentPanel({
  open,
  graphId,
  history,
  value,
  sending,
  feedback,
  undoBusy,
  onValueChange,
  onSend,
  onUndo,
  onClear,
  onClose,
}: AdjustmentPanelProps): ReactElement | null {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const trimmed = value.trim();
  const canSend = Boolean(graphId) && trimmed.length > 0 && trimmed.length <= 500 && !sending;
  const opCount = useMemo(
    () => history.reduce((sum, item) => sum + item.operations.length, 0),
    [history],
  );

  if (!open) return null;

  return (
    <div className="topo-adjust-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="topo-adjust-panel" role="dialog" aria-modal="true" aria-label="AI 微调当前视图">
        <header className="topo-adjust-head">
          <div>
            <div className="topo-rail-eyebrow">AI ADJUST · 自然语言微调</div>
            <h2>用一句话微调当前拓扑</h2>
            <p>只修改当前视图与标签，不改变原始学习版本；切换版本会按历史重新应用。</p>
          </div>
          <button type="button" className="topo-icon-btn" aria-label="关闭 AI 微调" onClick={onClose}>
            <MiniIcon name="close" size={16} />
          </button>
        </header>

        <div className="topo-adjust-body">
          <div className="topo-adjust-examples" aria-label="示例指令">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" onClick={() => onValueChange(example)} disabled={sending}>
                {example}
              </button>
            ))}
          </div>

          <div className="topo-adjust-input-wrap">
            <textarea
              className="topo-adjust-input"
              value={value}
              maxLength={500}
              rows={2}
              placeholder={graphId ? '描述你想怎么调整，例如：隐藏外部依赖；只看 prod-db-01…' : '当前没有可微调的拓扑图'}
              disabled={!graphId || sending}
              onChange={(event) => onValueChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) onSend();
                }
              }}
            />
            <div className="topo-adjust-input-bar">
              <span className={trimmed.length > 500 ? 'is-bad' : ''}>{trimmed.length} / 500</span>
              <span>Enter 发送 · Shift+Enter 换行</span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!canSend}
                onClick={onSend}
              >
                {sending ? <><span className="topo2-spinner is-small" /> 解析中…</> : <><MiniIcon name="spark" size={12} /> 发送</>}
              </button>
            </div>
          </div>

          {!graphId ? <p className="topo-adjust-disabled">当前没有图，无法使用 AI 微调。</p> : null}

          {sending ? (
            <div className="topo-adjust-loading">
              <span className="topo2-spinner" />
              <span>正在理解指令并生成视图操作…</span>
            </div>
          ) : null}

          {feedback ? (
            <div className="topo-adjust-result">
              {feedback.error ? (
                <div className="topo-adjust-error">
                  <MiniIcon name="warning" size={15} />
                  <div>
                    <strong>微调失败</strong>
                    <p>{feedback.error}</p>
                  </div>
                </div>
              ) : (
                <>
                  {feedback.clarification ? (
                    <div className="topo-adjust-clarify">
                      <MiniIcon name="alert" size={15} />
                      <div>
                        <strong>需要确认</strong>
                        <p>{feedback.clarification}</p>
                      </div>
                    </div>
                  ) : null}
                  <div className="topo-adjust-reply">
                    <MiniIcon name="spark" size={14} />
                    <p>{feedback.reply}</p>
                  </div>
                  {feedback.warning ? (
                    <div className="topo-adjust-warning"><MiniIcon name="warning" size={12} /> {warningLabel(feedback.warning)}</div>
                  ) : null}
                  {feedback.operations.length > 0 ? (
                    <div className="topo-adjust-ops">
                      <span>本次操作</span>
                      {feedback.operations.map((operation, index) => (
                        <em key={`${operation.op}-${index}`}>{operationLabel(operation)}</em>
                      ))}
                    </div>
                  ) : null}
                  <div className="topo-adjust-model">
                    <span>{feedback.fallback ? '规则建议' : '大模型'} · {feedback.model || '—'}</span>
                    <span>只影响当前视图</span>
                  </div>
                </>
              )}
            </div>
          ) : null}

          <div className="topo-adjust-history">
            <button type="button" className="topo-adjust-history-toggle" onClick={() => setHistoryOpen((current) => !current)}>
              <MiniIcon name="clock" size={13} />
              微调历史
              <em>{history.length} 次 · {opCount} 个操作</em>
              <span>{historyOpen ? '收起' : '展开'}</span>
            </button>
            {historyOpen ? (
              <div className="topo-adjust-history-list">
                {history.length === 0 ? <p className="topo-v4-muted">暂无微调历史。发送第一条指令后会记录在这里。</p> : null}
                {history.map((item) => (
                  <div key={item.id} className="topo-adjust-history-row">
                    <div>
                      <strong>{item.instruction}</strong>
                      <span>{relativeTime(item.createdAt)} · {item.operations.length} 个操作 · {item.fallback ? '规则兜底' : item.model}</span>
                    </div>
                    <em>{item.operations.map((operation) => operationLabel(operation)).join('；')}</em>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="topo-adjust-history-actions">
              <button type="button" className="btn btn-outline btn-sm" disabled={history.length === 0 || undoBusy || sending} onClick={onUndo}>
                <MiniIcon name="arrow-left" size={12} /> 撤销上次
              </button>
              {confirmClear ? (
                <>
                  <span className="topo-adjust-confirm">标签会被保留，仅清除视图微调历史。</span>
                  <button type="button" className="btn btn-outline btn-sm is-danger" disabled={undoBusy || sending} onClick={() => { setConfirmClear(false); onClear(); }}>
                    确认清空
                  </button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setConfirmClear(false)}>取消</button>
                </>
              ) : (
                <button type="button" className="btn btn-outline btn-sm" disabled={history.length === 0 || undoBusy || sending} onClick={() => setConfirmClear(true)}>
                  清空微调
                </button>
              )}
            </div>
          </div>
          <p className="topo-adjust-note">
            视图操作按历史顺序应用；「清空微调」不会删除已写入的标签。修改原始学习结果需要重新学习。
          </p>
        </div>
      </div>
    </div>
  );
}
