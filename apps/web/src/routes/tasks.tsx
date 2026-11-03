import { useEffect, useState } from 'react';
import { approveTask, createTask, listTasks, type TaskSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface TasksProps {
  readonly onBack: () => void;
}

export function Tasks({ onBack }: TasksProps) {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [scenarioId, setScenarioId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listTasks()
      .then(setTasks)
      .catch(() => setError('任务加载失败'));
  }, []);

  async function create() {
    if (!title.trim() || !scenarioId.trim()) {
      setError('请填写标题和场景 ID');
      return;
    }
    setError(null);
    try {
      const task = await createTask({ title: title.trim(), scenarioId: scenarioId.trim() });
      setTasks((current) => [task, ...(current ?? [])]);
      setTitle('');
    } catch {
      setError('创建任务失败');
    }
  }

  async function decide(id: string, decision: 'approve' | 'reject') {
    setError(null);
    try {
      const updated = await approveTask(id, decision);
      setTasks((current) => current?.map((item) => (item.id === id ? updated : item)) ?? current);
    } catch {
      setError('任务审批失败');
    }
  }

  return (
    <DesignShell
      active="tasks"
      eyebrow="Long running"
      title="长任务"
      subtitle="后台执行场景，审批挂起后可继续。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <section className="card">
        <div className="card-body">
          <h2>新建长任务</h2>
          <label htmlFor="task-title">标题</label>
          <input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor="task-scenario">场景 ID</label>
          <input id="task-scenario" value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} />
          <button type="button" className="btn btn-primary" onClick={() => void create()}>创建</button>
        </div>
      </section>
      {tasks === null ? <p className="muted">加载中…</p> : null}
      {tasks?.length === 0 ? <p className="muted">暂无长任务</p> : null}
      <section className="grid grid-3">
        {tasks?.map((task) => (
          <article key={task.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="badge badge-neutral">{task.status}</span>
              </div>
              <h3>{task.title}</h3>
              <p className="muted mono">{task.scenarioId}</p>
              {task.error ? <p role="alert">{task.error}</p> : null}
              {task.status === 'awaiting_approval' ? (
                <div className="row-sm">
                  <button type="button" className="btn btn-primary" onClick={() => void decide(task.id, 'approve')}>批准</button>
                  <button type="button" className="btn btn-outline" onClick={() => void decide(task.id, 'reject')}>拒绝</button>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
