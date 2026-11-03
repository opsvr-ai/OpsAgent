import { useEffect, useState } from 'react';
import { DesignShell } from './design-shell.js';
import {
  approveScenarioRun,
  createScenario,
  listScenarios,
  runScenario,
  setScenarioSchedule,
  type ScenarioRunSummary,
  type ScenarioSummary,
} from '../api/client.js';

export interface ScenariosProps {
  readonly onBack: () => void;
}

function describeStep(tool: string): { category: string; risk: string } {
  if (/prom|metric|grafana|zabbix/i.test(tool)) return { category: '监控分析', risk: 'R0–R1' };
  if (/sql|postgres|mysql|redis/i.test(tool)) return { category: '数据库', risk: 'R1–R2' };
  if (/ssh|disk|host|process/i.test(tool)) return { category: '主机运维', risk: 'R1–R2' };
  if (/k8s|kube|container/i.test(tool)) return { category: '容器平台', risk: 'R1–R3' };
  return { category: '自定义', risk: 'R0–R2' };
}

export function Scenarios({ onBack }: ScenariosProps) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [result, setResult] = useState<ScenarioRunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tool, setTool] = useState('');
  const [args, setArgs] = useState('{}');
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<'all' | 'published' | 'draft'>('all');

  async function create() {
    if (!name.trim() || !tool.trim()) {
      setError('请填写场景名称和工具');
      return;
    }
    setError(null);
    try {
      const input = JSON.parse(args) as Record<string, unknown>;
      const created = await createScenario({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        definition: { steps: [{ name: name.trim(), tool: tool.trim(), input }] },
      });
      setScenarios((current) => [created, ...(current ?? [])]);
      setName('');
      setDescription('');
      setTool('');
      setArgs('{}');
      setShowCreate(false);
    } catch {
      setError('创建场景失败，请检查工具名和 JSON 参数');
    }
  }

  useEffect(() => {
    void listScenarios()
      .then(setScenarios)
      .catch(() => setError('场景加载失败'));
  }, []);

  async function decide(decision: 'approve' | 'reject') {
    if (!result?.runId) return;
    setError(null);
    try {
      setResult(await approveScenarioRun(result.runId, decision));
    } catch {
      setError('审批失败');
    }
  }

  async function run(id: string) {
    setError(null);
    try {
      setResult(await runScenario(id));
    } catch {
      setError('场景运行失败');
    }
  }

  async function saveSchedule(id: string) {
    const raw = scheduleDraft[id] ?? '';
    const interval = raw.trim() === '' ? null : Number.parseInt(raw, 10);
    if (interval !== null && (!Number.isInteger(interval) || interval < 1)) {
      setError('定时分钟必须是正整数');
      return;
    }
    setError(null);
    try {
      await setScenarioSchedule(id, interval);
      setScenarios((current) =>
        current?.map((scenario) =>
          scenario.id === id ? { ...scenario, scheduleIntervalMinutes: interval } : scenario,
        ) ?? current,
      );
    } catch {
      setError('定时设置失败');
    }
  }

  const rows = (scenarios ?? []).filter((scenario) => tab === 'all' || scenario.status === tab);
  const published = scenarios?.filter((scenario) => scenario.status === 'published').length ?? 0;
  const scheduled = scenarios?.filter((scenario) => scenario.scheduleIntervalMinutes).length ?? 0;
  const steps = (scenarios ?? []).reduce((total, scenario) => total + scenario.definition.steps.length, 0);

  return (
    <DesignShell
      active="scenarios"
      eyebrow="Scenario hub · 可复用的运维流程"
      title="场景中心"
      subtitle="把巡检、排障与处置分析固化为场景模板；人工触发、定时调度、审批留痕。"
      onBack={onBack}
      actions={
        <>
          <button type="button" className="btn btn-outline" onClick={() => setShowCreate((current) => !current)}>从模板导入</button>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate((current) => !current)}>新建场景</button>
        </>
      }
    >
      {error ? <p role="alert">{error}</p> : null}

      <div className="status-strip" style={{ marginBottom: 20 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-bolt" /></svg></span><div><strong>可用场景</strong><span>{scenarios?.length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已发布</strong><span>{published} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-clock" /></svg></span><div><strong>定时任务</strong><span>{scheduled} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-grid" /></svg></span><div><strong>步骤总数</strong><span>{steps} 个步骤</span></div></div>
      </div>

      {showCreate ? (
        <section className="card">
          <div className="card-head"><h2>新建场景</h2><span className="muted">单步骤示例</span></div>
          <div className="card-body">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="scenario-name">名称</label>
                <input id="scenario-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 订单服务健康检查" />
              </div>
              <div className="field">
                <label htmlFor="scenario-desc">描述</label>
                <input id="scenario-desc" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选" />
              </div>
              <div className="field">
                <label htmlFor="scenario-tool">工具</label>
                <input id="scenario-tool" value={tool} onChange={(event) => setTool(event.target.value)} placeholder="例如 promql_query" />
              </div>
              <div className="field">
                <label htmlFor="scenario-args">参数 JSON</label>
                <input id="scenario-args" value={args} onChange={(event) => setArgs(event.target.value)} placeholder='{"query":"up"}' />
              </div>
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => void create()}>创建场景</button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="tabs" style={{ marginBottom: 14 }}>
        <button type="button" className={`tab${tab === 'all' ? ' is-active' : ''}`} onClick={() => setTab('all')}>全部<span className="count">{scenarios?.length ?? 0}</span></button>
        <button type="button" className={`tab${tab === 'published' ? ' is-active' : ''}`} onClick={() => setTab('published')}>已发布<span className="count">{published}</span></button>
        <button type="button" className={`tab${tab === 'draft' ? ' is-active' : ''}`} onClick={() => setTab('draft')}>草稿<span className="count">{(scenarios ?? []).filter((scenario) => scenario.status === 'draft').length}</span></button>
      </div>

      <div className="scenario-layout">
        <div>
          {scenarios === null ? <p className="muted">加载中…</p> : null}
          {scenarios?.length === 0 ? <p className="muted">暂无场景</p> : null}
          {scenarios && scenarios.length > 0 && rows.length === 0 ? <p className="muted">当前分类暂无场景</p> : null}
          <div className="grid scenario-cards">
            {rows.map((scenario) => {
              const firstTool = String((scenario.definition.steps[0] as { tool?: string } | undefined)?.tool ?? '');
              const meta = describeStep(firstTool);
              return (
                <article key={scenario.id} className="card scenario-card">
                  <div className="card-body">
                    <div className="scenario-top">
                      <span className="icon-tile is-blue"><svg><use href="/icons.svg#i-bolt" /></svg></span>
                      <span className="badge badge-neutral">{meta.category}</span>
                      <span className={`badge ${scenario.status === 'published' ? 'badge-ok' : 'badge-neutral'}`}>{scenario.status === 'published' ? '已发布' : scenario.status}</span>
                      <span className="badge badge-neutral">v{scenario.version}</span>
                    </div>
                    <h3>{scenario.name}</h3>
                    <p className="muted">{scenario.description ?? '暂无描述'}</p>
                    <p className="scenario-meta">{scenario.definition.steps.length} 个步骤 · {meta.risk} · {scenario.scheduleIntervalMinutes ? `每 ${scenario.scheduleIntervalMinutes} 分钟` : '手动触发'}</p>
                    <div className="row-sm">
                      <label htmlFor={`schedule-${scenario.id}`} className="muted">定时</label>
                      <input
                        id={`schedule-${scenario.id}`}
                        inputMode="numeric"
                        style={{ width: 72 }}
                        value={scheduleDraft[scenario.id] ?? (scenario.scheduleIntervalMinutes?.toString() ?? '')}
                        onChange={(event) =>
                          setScheduleDraft((current) => ({ ...current, [scenario.id]: event.target.value }))
                        }
                      />
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => void saveSchedule(scenario.id)}>设置定时</button>
                    </div>
                    <div className="row-sm">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void run(scenario.id)}>运行</button>
                      <span className="muted">{scenario.scheduleIntervalMinutes ? `每 ${scenario.scheduleIntervalMinutes} 分钟` : '未定时'}</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <aside className="stack">
          <section className="card">
            <div className="card-head"><h2>共享与发布</h2><span className="badge badge-neutral">租户内</span></div>
            <div className="card-body stack-sm">
              <div className="aside-row"><span>个人使用</span><span className="badge badge-ok">可用</span></div>
              <div className="aside-row"><span>角色可用</span><span className="badge badge-neutral">按角色</span></div>
              <div className="aside-row"><span>发布到租户</span><span className="badge badge-neutral">需审批</span></div>
              <p className="muted">场景默认只对创建者可见；发布到租户目录需提交共享申请。</p>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'shares' }))}>处理共享申请</button>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>最近运行</h2></div>
            <div className="card-body stack-sm">
              <div className="aside-row"><span>运行状态</span><span className={`badge ${result?.status === 'success' ? 'badge-ok' : 'badge-neutral'}`}>{result?.status ?? '暂无'}</span></div>
              <div className="aside-row"><span>定时场景</span><span className="mono">{scheduled}</span></div>
              <div className="aside-row"><span>步骤总数</span><span className="mono">{steps}</span></div>
            </div>
          </section>
        </aside>
      </div>

      {result ? (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-body">
            <h2>运行结果</h2>
            <p>{result.status}</p>
            {result.status === 'awaiting_approval' ? (
              <div className="row-sm">
                <button type="button" className="btn btn-primary" onClick={() => void decide('approve')}>批准</button>
                <button type="button" className="btn btn-outline" onClick={() => void decide('reject')}>拒绝</button>
              </div>
            ) : null}
            {result.error ? <p role="alert">{result.error}</p> : null}
          </div>
        </section>
      ) : null}
    </DesignShell>
  );
}
