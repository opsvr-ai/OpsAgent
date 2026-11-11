import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { TopologyAnalysisTrace, TopologyGraph } from '@opsagent/contracts';
import { relativeTime } from '../format.js';
import { MiniIcon } from './icons.js';

export interface AnalysisTracePanelProps {
  readonly open: boolean;
  readonly graph: TopologyGraph;
  readonly running: boolean;
  readonly startedAt: number | null;
  readonly requestError: string | null;
  readonly noSessionReason: string | null;
  readonly onClose: () => void;
  readonly onReanalyze: () => void;
  readonly onTestModel?: () => Promise<{ ok: boolean; message: string }>;
  readonly onOpenModels: () => void;
}

const CLIENT_STEPS = [
  { id: 'load-sample', label: '读取学习会话样本', detail: '读取当前 learning session 的采集窗口、主机与边样本' },
  { id: 'resolve-model', label: '解析默认模型', detail: '读取模型配置，解析 provider / baseUrl 与凭据' },
  { id: 'build-prompt', label: '组装分析 Prompt', detail: '把主机、端口、进程与连接证据拼装为分析提示词' },
  { id: 'request-model', label: '调用大模型', detail: '等待默认模型的 JSON 结构化分析响应' },
  { id: 'parse-response', label: '解析并校验响应', detail: '校验 JSON 结构、组件与分层，生成洞察/链路/风险' },
  { id: 'finalize', label: '生成新图', detail: '写入 graph，刷新画布、分析侧栏与版本历史' },
] as const;

const STATUS_LABEL: Record<TopologyAnalysisTrace['status'], string> = {
  success: '分析成功',
  fallback: '规则兜底',
  error: '分析失败',
};

const STEP_ICON: Record<'ok' | 'error' | 'skipped', string> = {
  ok: '✓',
  error: '!',
  skipped: '–',
};

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function formatTime(value: string | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="topo-trace-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function AnalysisTracePanel({
  open,
  graph,
  running,
  startedAt,
  requestError,
  noSessionReason,
  onClose,
  onReanalyze,
  onTestModel,
  onOpenModels,
}: AnalysisTracePanelProps): ReactElement | null {
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testText, setTestText] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !running) return;
    const tick = (): void => setElapsed(startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0);
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [open, running, startedAt]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      setCopied(false);
      setTestText(null);
    }
  }, [open]);

  const trace = graph.analysis.trace;
  const analysis = graph.analysis;
  const canReanalyze = Boolean(graph.sessionId) && !running;
  const completedSteps = Math.min(CLIENT_STEPS.length, Math.floor(elapsed / 1.4));
  const activeStep = completedSteps < CLIENT_STEPS.length ? completedSteps : CLIENT_STEPS.length - 1;

  const excerpt = trace?.request?.responseExcerpt ?? '';
  const hasTrace = Boolean(trace);
  const effectiveStatus = trace?.status;
  const errorMessage = requestError ?? trace?.error?.message ?? null;
  const errorCode = trace?.error?.code ?? null;

  const modelRows = useMemo(() => {
    if (!trace) return [];
    return [
      { label: '模型', value: trace.model.name ?? '（未解析）' },
      { label: 'Provider', value: trace.model.provider ?? '—' },
      { label: 'Base URL', value: trace.model.baseUrl ?? '—' },
    ];
  }, [trace]);

  if (!open) return null;

  const copyExcerpt = (): void => {
    if (!excerpt) return;
    void navigator.clipboard
      .writeText(excerpt)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => setCopied(false));
  };

  return (
    <div className="topo-trace-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="topo-trace-panel" role="dialog" aria-modal="true" aria-label="模型分析过程">
        <header className="topo-trace-head">
          <div>
            <div className="topo-rail-eyebrow">ANALYSIS TRACE · 模型分析过程</div>
            <h2>分析过程与错误详情</h2>
            <div className="topo-trace-sub">
              <span className={`topo-trace-status is-${running ? 'running' : effectiveStatus ?? (hasTrace ? 'success' : 'none')}`}>
                {running ? '进行中' : effectiveStatus ? STATUS_LABEL[effectiveStatus] : '未记录 trace'}
              </span>
              <span>生成于 {relativeTime(analysis.generatedAt)}</span>
              <span>总耗时 {formatDuration(running ? elapsed * 1000 : trace?.durationMs ?? analysis.durationMs)}</span>
            </div>
          </div>
          <button type="button" className="topo-icon-btn" aria-label="关闭分析过程" onClick={onClose}>
            <MiniIcon name="close" size={16} />
          </button>
        </header>

        <div className="topo-trace-body">
          {running ? (
            <section className="topo-trace-progress">
              <div className="topo-trace-progress-head">
                <span className="topo2-spinner" />
                <strong>正在使用当前模型重新分析</strong>
                <span className="mono">已用 {elapsed}s</span>
              </div>
              <p className="topo-trace-progress-note">
                请求会按以下客户端阶段推进；实际模型调用的耗时与结果以服务端 trace 为准。
              </p>
              <ol className="topo-trace-steps">
                {CLIENT_STEPS.map((step, index) => {
                  const status = index < completedSteps ? 'ok' : index === activeStep ? 'running' : 'pending';
                  return (
                    <li key={step.id} className={`topo-trace-step is-${status}`}>
                      <span className="topo-trace-step-dot">{status === 'ok' ? '✓' : status === 'running' ? '' : index + 1}</span>
                      <span className="topo-trace-step-main">
                        <strong>{step.label}</strong>
                        <span>{step.detail}</span>
                      </span>
                      <span className="topo-trace-step-time">{status === 'running' ? '进行中' : status === 'ok' ? '完成' : '等待'}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : hasTrace && trace ? (
            <>
              {trace.status !== 'success' || trace.fallbackReason ? (
                <section className="topo-trace-error">
                  <div className="topo-trace-error-head">
                    <MiniIcon name="warning" size={15} />
                    <strong>{trace.status === 'error' ? '分析失败' : '模型不可用，已规则兜底'}</strong>
                    {errorCode ? <code>{errorCode}</code> : null}
                  </div>
                  {errorMessage ? <p>{errorMessage}</p> : null}
                  {trace.fallbackReason ? (
                    <p className="topo-trace-reason">
                      fallbackReason：<code>{trace.fallbackReason}</code>
                    </p>
                  ) : null}
                  {trace.status !== 'success' ? <p className="topo-trace-hint">可点击「测试当前模型」检查凭据与连通性，或到模型配置调整默认模型。</p> : null}
                </section>
              ) : (
                <section className="topo-trace-success">
                  <MiniIcon name="spark" size={15} />
                  <strong>模型调用与解析成功</strong>
                  <span>HTTP {trace.request?.httpStatus ?? '—'} · 响应 {trace.request?.responseChars?.toLocaleString('zh-CN') ?? '—'} 字符</span>
                </section>
              )}

              <section className="topo-trace-section">
                <div className="topo-trace-section-head">
                  <h3>步骤时间线</h3>
                  <span>共 {trace.steps.length} 步</span>
                </div>
                <ol className="topo-trace-steps">
                  {trace.steps.map((step) => (
                    <li key={step.id} className={`topo-trace-step is-${step.status}`}>
                      <span className="topo-trace-step-dot">{STEP_ICON[step.status]}</span>
                      <span className="topo-trace-step-main">
                        <strong>{step.label}</strong>
                        {step.detail ? <span>{step.detail}</span> : null}
                      </span>
                      <span className="topo-trace-step-time">{formatDuration(step.durationMs)}</span>
                    </li>
                  ))}
                </ol>
              </section>

              <div className="topo-trace-grid">
                <section className="topo-trace-section">
                  <div className="topo-trace-section-head">
                    <h3>模型解析</h3>
                    {!trace.model.resolved ? <span className="is-bad">未解析到默认模型</span> : <span>已解析</span>}
                  </div>
                  <div className="topo-trace-metrics">
                    {modelRows.map((row) => <Metric key={row.label} label={row.label} value={row.value} />)}
                    <Metric label="resolved" value={trace.model.resolved ? 'true' : 'false'} />
                  </div>
                  {!trace.model.resolved ? (
                    <p className="topo-trace-bad">未解析到默认模型，请到「模型配置」添加并启用模型。</p>
                  ) : null}
                </section>

                <section className="topo-trace-section">
                  <div className="topo-trace-section-head">
                    <h3>Prompt</h3>
                    <span>{trace.prompt.version}</span>
                  </div>
                  <div className="topo-trace-metrics">
                    <Metric label="字符数" value={trace.prompt.chars.toLocaleString('zh-CN')} />
                    <Metric label="主机" value={String(trace.prompt.hosts)} />
                    <Metric label="链路" value={String(trace.prompt.edges)} />
                    <Metric label="预算" value={trace.prompt.budgetChars ? trace.prompt.budgetChars.toLocaleString('zh-CN') : '—'} />
                  </div>
                </section>
              </div>

              {trace.request ? (
                <section className="topo-trace-section">
                  <div className="topo-trace-section-head">
                    <h3>模型请求</h3>
                    <span>HTTP {trace.request.httpStatus ?? '—'}</span>
                  </div>
                  <div className="topo-trace-metrics">
                    <Metric label="请求耗时" value={formatDuration(trace.request.durationMs)} />
                    <Metric label="HTTP 状态" value={trace.request.httpStatus ? String(trace.request.httpStatus) : '—'} />
                    <Metric label="响应字符" value={trace.request.responseChars?.toLocaleString('zh-CN') ?? '—'} />
                  </div>
                  {excerpt ? (
                    <details className="topo-trace-response">
                      <summary>
                        响应片段（{excerpt.length.toLocaleString('zh-CN')} 字符，默认折叠）
                        <button
                          type="button"
                          className="topo-trace-copy"
                          onClick={(event) => {
                            event.preventDefault();
                            copyExcerpt();
                          }}
                        >
                          {copied ? '已复制' : '复制'}
                        </button>
                      </summary>
                      <pre>{excerpt}</pre>
                    </details>
                  ) : null}
                </section>
              ) : null}

              <div className="topo-trace-meta">
                <span>trace id <code>{trace.id}</code></span>
                <span>开始 {formatTime(trace.startedAt)}</span>
                <span>完成 {formatTime(trace.completedAt)}</span>
              </div>
            </>
          ) : (
            <section className="topo-trace-legacy">
              <div className="topo-trace-legacy-head">
                <MiniIcon name="clock" size={18} />
                <strong>该图生成时未记录分析过程</strong>
              </div>
              <p>这是旧版本图（trace 上线前生成）。点击「用当前模型重新分析」会重新调用默认模型并记录完整 trace。</p>
              <div className="topo-trace-metrics">
                <Metric label="当前 analysis.model" value={analysis.model || '—'} />
                <Metric label="fallback" value={analysis.fallback ? 'true' : 'false'} />
                <Metric label="fallbackReason" value={analysis.fallbackReason ?? '—'} />
                <Metric label="promptVersion" value={analysis.promptVersion} />
                <Metric label="生成时间" value={relativeTime(analysis.generatedAt)} />
                <Metric label="graph 版本" value={`v${graph.version}`} />
              </div>
              {analysis.fallbackReason ? (
                <p className="topo-trace-bad">当前兜底原因：<code>{analysis.fallbackReason}</code></p>
              ) : null}
            </section>
          )}

          {requestError && !running ? (
            <section className="topo-trace-error">
              <div className="topo-trace-error-head">
                <MiniIcon name="warning" size={15} />
                <strong>重新分析请求失败</strong>
              </div>
              <p>{requestError}</p>
            </section>
          ) : null}

          {testText ? <p className={`topo-trace-test ${testText.startsWith('测试失败') ? 'is-bad' : ''}`}>{testText}</p> : null}
        </div>

        <footer className="topo-trace-foot">
          <div className="topo-trace-foot-left">
            {noSessionReason ? <span className="topo-trace-disabled-reason">{noSessionReason}</span> : null}
            {onTestModel ? (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={testing}
                onClick={() => {
                  setTesting(true);
                  setTestText(null);
                  void onTestModel()
                    .then((result) => setTestText(result.message))
                    .catch((error: unknown) => setTestText(`测试失败：${error instanceof Error ? error.message : 'unknown'}`))
                    .finally(() => setTesting(false));
                }}
              >
                <MiniIcon name="spark" size={12} /> {testing ? '测试中…' : '测试当前模型'}
              </button>
            ) : null}
            <button type="button" className="btn btn-outline btn-sm" onClick={onOpenModels}>
              <MiniIcon name="settings" size={12} /> 模型配置
            </button>
          </div>
          <div className="topo-trace-foot-right">
            <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>关闭</button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={running || !canReanalyze}
              title={noSessionReason ?? (running ? '正在重新分析' : '用当前默认模型重新分析并记录 trace')}
              onClick={onReanalyze}
            >
              <MiniIcon name="refresh" size={12} /> {running ? '分析中…' : '用当前模型重新分析'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
