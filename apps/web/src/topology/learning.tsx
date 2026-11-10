import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type {
  TopologyLearningPolicy,
  TopologyLearningPolicyUpdate,
  TopologyLearningSession,
} from '@opsagent/contracts';
import { MiniIcon } from './icons.js';

export interface AppSystemOption {
  readonly id: string;
  readonly name: string;
}

const WINDOW_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: '1 分钟' },
  { seconds: 300, label: '5 分钟' },
  { seconds: 900, label: '15 分钟' },
];

const PHASE_LABEL: Record<string, string> = {
  collecting: '正在采集建连边',
  aggregating: '正在聚合边样本',
  analyzing: '大模型正在生成拓扑',
  ready: '拓扑已生成',
  failed: '学习失败',
  cancelled: '已取消',
};

function formatDuration(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} 小时`;
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  }
  return `${seconds} 秒`;
}

export interface LearningWizardProps {
  readonly open: boolean;
  readonly appSystems: readonly AppSystemOption[];
  readonly defaultAppSystemId: string;
  readonly busy: boolean;
  readonly session: TopologyLearningSession | null;
  readonly graphVersion: number | null;
  readonly error: string | null;
  readonly onStart: (input: { appSystemId: string | null; windowSeconds: number; includeUnassigned: boolean }) => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

export function LearningWizard({
  open,
  appSystems,
  defaultAppSystemId,
  busy,
  session,
  graphVersion,
  error,
  onStart,
  onCancel,
  onRetry,
  onClose,
}: LearningWizardProps): ReactElement | null {
  const [appSystemId, setAppSystemId] = useState(defaultAppSystemId);
  const [seconds, setSeconds] = useState(300);
  const [custom, setCustom] = useState('120');
  const [includeUnassigned, setIncludeUnassigned] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);

  useEffect(() => {
    if (open) {
      setAppSystemId(defaultAppSystemId);
      setIncludeUnassigned(false);
      setErrorDismissed(false);
    }
  }, [open, defaultAppSystemId]);

  if (!open) return null;

  const running = session !== null && ['collecting', 'aggregating', 'analyzing'].includes(session.status);
  const ready = session?.status === 'ready';
  const failed = session?.status === 'failed' || Boolean(error);
  const percent = session ? Math.round(session.progress.percent * 100) : 0;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;

  const submit = (): void => {
    const windowSeconds = Math.min(1800, Math.max(60, seconds === 0 ? Number(custom) || 60 : seconds));
    onStart({ appSystemId: appSystemId || null, windowSeconds, includeUnassigned });
  };

  return (
    <div
      className="topo-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !running) onClose();
      }}
      role="presentation"
    >
      <div className="topo-modal topo-learning-modal" role="dialog" aria-modal="true" aria-label="学习访问拓扑">
        <div className="topo-modal-head">
          <div>
            <div className="topo-rail-eyebrow">TOPOLOGY LEARNING · 固定窗口学习</div>
            <h2 className="topo-modal-title">学习访问拓扑</h2>
            <p className="topo-modal-sub">在时间窗内采集纳管主机的端口、进程与建连证据，由大模型识别组件与 IT 分层并生成拓扑。</p>
          </div>
          <button type="button" className="topo-icon-btn" aria-label="关闭" onClick={onClose} disabled={busy && running}>
            <MiniIcon name="close" size={16} />
          </button>
        </div>

        {!session ? (
          <div className="topo-modal-body">
            <div className="topo-form-block">
              <div className="topo-form-label">
                <span>作用范围</span>
                <em>整个租户或单个应用系统</em>
              </div>
              <div className="topo-choice-row">
                <button
                  type="button"
                  className={`topo-choice${appSystemId === '' ? ' is-on' : ''}`}
                  onClick={() => setAppSystemId('')}
                >
                  全部应用系统
                </button>
                {appSystems.map((system) => (
                  <button
                    key={system.id}
                    type="button"
                    className={`topo-choice${appSystemId === system.id ? ' is-on' : ''}`}
                    onClick={() => setAppSystemId(system.id)}
                  >
                    {system.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="topo-form-block">
              <div className="topo-form-label">
                <span>采集时间窗</span>
                <em>窗口越长，样本越完整，等待越久</em>
              </div>
              <div className="topo-choice-row">
                {WINDOW_OPTIONS.map((option) => (
                  <button
                    key={option.seconds}
                    type="button"
                    className={`topo-choice${seconds === option.seconds ? ' is-on' : ''}`}
                    onClick={() => setSeconds(option.seconds)}
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`topo-choice${seconds === 0 ? ' is-on' : ''}`}
                  onClick={() => setSeconds(0)}
                >
                  自定义
                </button>
                {seconds === 0 ? (
                  <label className="topo-custom-window">
                    <input
                      type="number"
                      className="input"
                      min={60}
                      max={1800}
                      value={custom}
                      onChange={(event) => setCustom(event.target.value)}
                      aria-label="自定义时间窗（秒）"
                    />
                    <span>秒</span>
                  </label>
                ) : null}
              </div>
              <p className="topo-form-hint">
                窗口结束后自动聚合边样本并调用分析器；期间可在进度页取消。建议首次学习使用 5 分钟。
              </p>
            </div>

            <div className="topo-toggle-row topo-toggle-inline">
              <div>
                <strong>包含未归属主机</strong>
                <span>默认关闭：不属于任何应用系统的纳管主机不进入拓扑，避免公共主机混入业务视图。</span>
              </div>
              <button
                type="button"
                className={`switch topo-switch${includeUnassigned ? ' is-on' : ''}`}
                aria-pressed={includeUnassigned}
                aria-label="包含未归属主机"
                onClick={() => setIncludeUnassigned((current) => !current)}
              />
            </div>

            <div className="topo-learning-steps">
              <div className="topo-learning-step is-done">
                <span className="topo-step-index">
                  <MiniIcon name="clock" size={13} />
                </span>
                <div>
                  <strong>采集</strong>
                  <span>Agent 按 10s 窗口上报建连边</span>
                </div>
              </div>
              <div className="topo-learning-step">
                <span className="topo-step-index">
                  <MiniIcon name="layers" size={13} />
                </span>
                <div>
                  <strong>学习</strong>
                  <span>聚合去重、归因到主机与服务</span>
                </div>
              </div>
              <div className="topo-learning-step">
                <span className="topo-step-index">
                  <MiniIcon name="spark" size={13} />
                </span>
                <div>
                  <strong>生成</strong>
                  <span>大模型分层、洞察与核心链路</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="topo-modal-body">
            <div className="topo-learning-progress">
              <div className="topo-ring">
                <svg viewBox="0 0 128 128" width="128" height="128" aria-hidden="true">
                  <circle className="topo-ring-track" cx="64" cy="64" r={radius} />
                  <circle
                    className={`topo-ring-value${ready ? ' is-ready' : ''}${failed ? ' is-failed' : ''}`}
                    cx="64"
                    cy="64"
                    r={radius}
                    strokeDasharray={`${circumference}`}
                    strokeDashoffset={`${circumference * (1 - (ready ? 1 : percent / 100))}`}
                  />
                </svg>
                <div className="topo-ring-center">
                  <strong>{ready ? '100' : percent}%</strong>
                  <span>{ready ? '已完成' : PHASE_LABEL[session.status] ?? session.status}</span>
                </div>
              </div>
              <div className="topo-learning-stats">
                <div>
                  <span>已上报 Agent</span>
                  <strong>
                    {session.progress.reportingAgents}
                    <em> / {session.progress.expectedAgents || '—'}</em>
                  </strong>
                </div>
                <div>
                  <span>边样本</span>
                  <strong>{session.progress.edgeSamples.toLocaleString('zh-CN')}</strong>
                </div>
                <div>
                  <span>去重链路</span>
                  <strong>{session.progress.uniqueEdges}</strong>
                </div>
                <div>
                  <span>{ready ? '窗口结束' : '剩余时间'}</span>
                  <strong>{ready ? formatDuration(session.windowSeconds) : `${session.progress.remainingSeconds}s`}</strong>
                </div>
              </div>
            </div>

            <div className="topo-phase-track">
              {(['collecting', 'analyzing', 'ready'] as const).map((phase, index) => {
                const order = ['collecting', 'aggregating', 'analyzing', 'ready'];
                const currentIndex = order.indexOf(session.status);
                const state = ready
                  ? 'is-done'
                  : failed
                    ? 'is-failed'
                    : currentIndex >= index
                      ? 'is-active'
                      : '';
                return (
                  <div key={phase} className={`topo-phase ${state}`}>
                    <span className="topo-phase-dot" />
                    <div>
                      <strong>{phase === 'collecting' ? '采集窗口' : phase === 'analyzing' ? '模型分析' : '生成拓扑'}</strong>
                      <span>{PHASE_LABEL[phase]}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {ready ? (
              <div className="topo-learning-result">
                <MiniIcon name="spark" size={16} />
                <div>
                  <strong>已生成第 {graphVersion ?? '—'} 版拓扑</strong>
                  <span>拓扑画布已自动刷新为最新版本，分析结论可在右侧查看。</span>
                </div>
              </div>
            ) : null}

            {failed && !errorDismissed ? (
              <div className="topo-learning-error">
                <MiniIcon name="warning" size={16} />
                <div>
                  <strong>学习失败</strong>
                  <span>{session.error ?? error ?? '分析器没有返回结果，请重试。'}</span>
                </div>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setErrorDismissed(true)}>
                  忽略
                </button>
                <button type="button" className="btn btn-outline btn-sm" onClick={onRetry} disabled={busy}>
                  重试分析
                </button>
              </div>
            ) : null}
          </div>
        )}

        <div className="topo-modal-foot">
          {!session ? (
            <>
              <span className="topo-modal-foot-hint">学习期间不会影响线上流量，仅读取连接元数据。</span>
              <button type="button" className="btn btn-outline" onClick={onClose}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
                <MiniIcon name="play" size={14} /> 开始学习
              </button>
            </>
          ) : (
            <>
              <span className="topo-modal-foot-hint">
                {running ? '正在学习，完成后自动加载最新拓扑。' : ready ? '可以关闭窗口查看拓扑。' : '可以重试或取消本次学习。'}
              </span>
              {running ? (
                <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>
                  取消学习
                </button>
              ) : null}
              {failed && errorDismissed ? (
                <button type="button" className="btn btn-outline" onClick={() => setErrorDismissed(false)}>
                  查看错误
                </button>
              ) : null}
              <button type="button" className="btn btn-primary" onClick={onClose} disabled={running && busy}>
                {ready ? '查看拓扑' : '关闭'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export interface PolicyPanelProps {
  readonly open: boolean;
  readonly policy: TopologyLearningPolicy | null;
  readonly appSystems: readonly AppSystemOption[];
  readonly saving: boolean;
  readonly error: string | null;
  readonly onSave: (input: TopologyLearningPolicyUpdate) => void;
  readonly onClose: () => void;
}

const INTERVAL_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 3600, label: '每 1 小时' },
  { seconds: 21_600, label: '每 6 小时' },
  { seconds: 43_200, label: '每 12 小时' },
  { seconds: 86_400, label: '每 24 小时' },
];

export function PolicyPanel({
  open,
  policy,
  appSystems,
  saving,
  error,
  onSave,
  onClose,
}: PolicyPanelProps): ReactElement | null {
  const [enabled, setEnabled] = useState(policy?.enabled ?? true);
  const [intervalSeconds, setIntervalSeconds] = useState(policy?.intervalSeconds ?? 21_600);
  const [windowSeconds, setWindowSeconds] = useState(policy?.windowSeconds ?? 900);
  const [appSystemId, setAppSystemId] = useState(policy?.scope.appSystemId ?? '');
  const [includeUnassigned, setIncludeUnassigned] = useState(policy?.includeUnassigned ?? false);

  useEffect(() => {
    if (!open || !policy) return;
    setEnabled(policy.enabled);
    setIntervalSeconds(policy.intervalSeconds);
    setWindowSeconds(policy.windowSeconds);
    setAppSystemId(policy.scope.appSystemId ?? '');
    setIncludeUnassigned(policy.includeUnassigned);
  }, [open, policy]);

  if (!open) return null;

  const nextRun = policy?.nextRunAt ? new Date(policy.nextRunAt) : null;
  const lastRun = policy?.lastRunAt ? new Date(policy.lastRunAt) : null;
  const format = (date: Date | null): string =>
    date ? date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div
      className="topo-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div className="topo-modal topo-policy-modal" role="dialog" aria-modal="true" aria-label="自动学习策略">
        <div className="topo-modal-head">
          <div>
            <div className="topo-rail-eyebrow">AUTO LEARNING · 自动学习策略</div>
            <h2 className="topo-modal-title">自动学习策略</h2>
            <p className="topo-modal-sub">按固定周期自动学习访问拓扑，生成新版本并保留历史。</p>
          </div>
          <button type="button" className="topo-icon-btn" aria-label="关闭" onClick={onClose}>
            <MiniIcon name="close" size={16} />
          </button>
        </div>

        <div className="topo-modal-body">
          <div className="topo-toggle-row">
            <div>
              <strong>启用自动学习</strong>
              <span>周期到达时自动开启一次固定窗口学习，无需手动触发。</span>
            </div>
            <button
              type="button"
              className={`switch${enabled ? ' is-on' : ''}`}
              aria-pressed={enabled}
              aria-label="启用自动学习"
              onClick={() => setEnabled((current) => !current)}
            />
          </div>

          <div className="topo-form-block">
            <div className="topo-form-label">
              <span>学习周期</span>
              <em>推荐每 6 小时，兼顾新鲜度与采集开销</em>
            </div>
            <div className="topo-choice-row">
              {INTERVAL_OPTIONS.map((option) => (
                <button
                  key={option.seconds}
                  type="button"
                  className={`topo-choice${intervalSeconds === option.seconds ? ' is-on' : ''}`}
                  onClick={() => setIntervalSeconds(option.seconds)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="topo-form-block">
            <div className="topo-form-label">
              <span>窗口长度</span>
              <em>每次学习读取最近多久的连接样本</em>
            </div>
            <div className="topo-choice-row">
              {WINDOW_OPTIONS.map((option) => (
                <button
                  key={option.seconds}
                  type="button"
                  className={`topo-choice${windowSeconds === option.seconds ? ' is-on' : ''}`}
                  onClick={() => setWindowSeconds(option.seconds)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="topo-form-block">
            <div className="topo-form-label">
              <span>作用范围</span>
              <em>学习整个租户，或只学习一个应用系统</em>
            </div>
            <div className="topo-choice-row">
              <button type="button" className={`topo-choice${appSystemId === '' ? ' is-on' : ''}`} onClick={() => setAppSystemId('')}>
                全部应用系统
              </button>
              {appSystems.map((system) => (
                <button
                  key={system.id}
                  type="button"
                  className={`topo-choice${appSystemId === system.id ? ' is-on' : ''}`}
                  onClick={() => setAppSystemId(system.id)}
                >
                  {system.name}
                </button>
              ))}
            </div>
          </div>

          <div className="topo-toggle-row">
            <div>
              <strong>包含未归属主机</strong>
              <span>关闭时仅学习已归属应用系统的主机；公共主机不会进入业务拓扑。</span>
            </div>
            <button
              type="button"
              className={`switch topo-switch${includeUnassigned ? ' is-on' : ''}`}
              aria-pressed={includeUnassigned}
              aria-label="包含未归属主机"
              onClick={() => setIncludeUnassigned((current) => !current)}
            />
          </div>

          <div className="topo-policy-meta">
            <div>
              <span>上次运行</span>
              <strong>{format(lastRun)}</strong>
            </div>
            <div>
              <span>下次运行</span>
              <strong>{format(nextRun)}</strong>
            </div>
            <div>
              <span>当前状态</span>
              <strong className={policy?.enabled ? 'text-ok' : 'muted'}>{policy?.enabled ? '已启用' : '已停用'}</strong>
            </div>
          </div>

          {error ? <p className="topo-inline-error">{error}</p> : null}
        </div>

        <div className="topo-modal-foot">
          <span className="topo-modal-foot-hint">策略保存后立即生效，下一次运行时间由服务端计算。</span>
          <button type="button" className="btn btn-outline" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() =>
              onSave({
                enabled,
                intervalSeconds,
                windowSeconds,
                scope: appSystemId ? { kind: 'app-system', appSystemId } : { kind: 'tenant' },
                includeUnassigned,
              })
            }
          >
            {saving ? '保存中…' : '保存策略'}
          </button>
        </div>
      </div>
    </div>
  );
}
