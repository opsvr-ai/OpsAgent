import { useEffect, useState } from 'react';
import {
  listScenarios,
  runScenario,
  setScenarioSchedule,
  type ScenarioRunSummary,
  type ScenarioSummary,
} from '../api/client.js';

export interface ScenariosProps {
  readonly onBack: () => void;
}

export function Scenarios({ onBack }: ScenariosProps) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [result, setResult] = useState<ScenarioRunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    void listScenarios()
      .then(setScenarios)
      .catch(() => setError('场景加载失败'));
  }, []);

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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">OpsAgent</div>
        <div className="tenant">
          <strong>场景中心</strong>
          <span>可复用运维流程</span>
        </div>
        <button type="button" onClick={onBack}>返回工作台</button>
      </aside>
      <main className="page">
        <header>
          <div className="eyebrow">Scenarios</div>
          <h1>场景中心</h1>
        </header>
        {error ? <p role="alert">{error}</p> : null}
        {scenarios === null ? <p className="muted">加载中…</p> : null}
        {scenarios?.length === 0 ? <p className="muted">暂无场景</p> : null}
        <section className="cards">
          {scenarios?.map((scenario) => (
            <article key={scenario.id} className="card">
              <h2>{scenario.name}</h2>
              <p className="muted">{scenario.description ?? '—'}</p>
              <p className="muted">
                {scenario.status} · v{scenario.version} · {scenario.definition.steps.length} steps
              </p>
              {scenario.scheduleIntervalMinutes ? (
                <p className="muted">每 {scenario.scheduleIntervalMinutes} 分钟</p>
              ) : null}
              <div className="schedule-row">
                <label htmlFor={`schedule-${scenario.id}`}>定时分钟</label>
                <input
                  id={`schedule-${scenario.id}`}
                  inputMode="numeric"
                  value={
                    scheduleDraft[scenario.id] ??
                    (scenario.scheduleIntervalMinutes?.toString() ?? '')
                  }
                  onChange={(event) =>
                    setScheduleDraft((current) => ({
                      ...current,
                      [scenario.id]: event.target.value,
                    }))
                  }
                />
                <button type="button" onClick={() => void saveSchedule(scenario.id)}>
                  设置定时
                </button>
              </div>
              <button type="button" onClick={() => void run(scenario.id)}>运行</button>
            </article>
          ))}
        </section>
        {result ? (
          <section className="card" style={{ marginTop: 16 }}>
            <h2>运行结果</h2>
            <p>{result.status}</p>
            {result.error ? <p role="alert">{result.error}</p> : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
