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
  const [showCreate, setShowCreate] = useState(false);

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
      setShowCreate(false);
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

  const success = tasks?.filter((task) => task.status === 'success').length ?? 0;
  const active = tasks?.filter((task) => ['queued', 'running'].includes(task.status)).length ?? 0;
  const awaiting = tasks?.filter((task) => task.status === 'awaiting_approval').length ?? 0;
  const failed = tasks?.filter((task) => task.status === 'failed').length ?? 0;

  return (
    <DesignShell
      active="tasks"
      eyebrow="Long-running tasks · 无人值守巡检"
      title="长任务中心"
      subtitle="把巡检、健康检查、批量采集等耗时任务转为长任务执行；可暂停、审批、重试与恢复。"
      onBack={onBack}
      actions={<button type="button" className="btn btn-primary" onClick={() => setShowCreate((current) => !current)}>新建任务</button>}
    >
      {error ? <p role="alert">{error}</p> : null}

      <div className="status-strip" style={{ marginBottom: 20 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-clock" /></svg></span><div><strong>运行中</strong><span>{active} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已成功</strong><span>{success} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>待审批</strong><span>{awaiting} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-activity" /></svg></span><div><strong>失败</strong><span>{failed} 个</span></div></div>
      </div>

      {showCreate ? (
        <section className="card">
          <div className="card-head"><h2>新建长任务</h2><span className="muted">后台执行，可审批恢复</span></div>
          <div className="card-body">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="task-title">标题</label>
                <input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 夜间巡检" />
              </div>
              <div className="field">
                <label htmlFor="task-scenario">场景 ID</label>
                <input id="task-scenario" value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} placeholder="场景 ID" />
              </div>
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => void create()}>创建任务</button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="task-layout">
        <section className="card">
          <div className="card-head"><h2>任务列表</h2><span className="muted">{tasks?.length ?? 0} 个任务</span></div>
          <div className="card-body">
            {tasks === null ? <p className="muted">加载中…</p> : null}
            {tasks?.length === 0 ? <p className="muted">暂无长任务</p> : null}
            {tasks && tasks.length > 0 ? (
              <table className="table">
                <thead><tr><th>任务</th><th>场景</th><th>状态</th><th /></tr></thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.id}>
                      <td className="cell-main">{task.title}</td>
                      <td className="muted">{task.scenarioName ?? task.scenarioId}</td>
                      <td><span className={`badge ${task.status === 'success' ? 'badge-ok' : task.status === 'failed' ? 'badge-warn' : 'badge-neutral'}`}>{task.status}</span></td>
                      <td className="actions-cell">
                        {task.status === 'awaiting_approval' ? (
                          <div className="row-sm">
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => void decide(task.id, 'approve')}>批准</button>
                            <button type="button" className="btn btn-outline btn-sm" onClick={() => void decide(task.id, 'reject')}>拒绝</button>
                          </div>
                        ) : null}
                        {task.error ? <span className="muted">{task.error}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </section>

        <aside className="stack">
          <section className="card">
            <div className="card-head"><h2>无人值守调度</h2><span className="badge badge-ok">运行中</span></div>
            <div className="card-body stack-sm">
              <div className="aside-row"><span>调度窗口</span><span className="mono">00:00–07:00</span></div>
              <div className="aside-row"><span>并发上限</span><span className="mono">2</span></div>
              <div className="aside-row"><span>默认重试</span><span className="mono">3 次</span></div>
              <div className="aside-row"><span>暂停窗口</span><span className="mono">发布会</span></div>
              <p className="muted">长任务优先在低峰期执行；遇到 R2/R3 操作自动挂起并通知审批人。</p>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>运行分析</h2></div>
            <div className="card-body stack-sm">
              <div className="aside-row"><span>今日运行</span><span className="mono">{tasks?.length ?? 0}</span></div>
              <div className="aside-row"><span>成功</span><span className="mono">{success}</span></div>
              <div className="aside-row"><span>待审批</span><span className="mono">{awaiting}</span></div>
              <div className="aside-row"><span>失败</span><span className="mono">{failed}</span></div>
            </div>
          </section>
        </aside>
      </div>
    </DesignShell>
  );
}
