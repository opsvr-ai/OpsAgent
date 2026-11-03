import { useEffect, useState } from 'react';
import {
  listScenarios,
  runScenario,
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
