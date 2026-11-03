import { useEffect, useState } from 'react';
import {
  createStudioSession,
  listStudioSessions,
  reviewStudioSession,
  submitStudioSession,
  type StudioSession,
} from '../api/client.js';

export interface StudioProps {
  readonly onBack: () => void;
}

export function Studio({ onBack }: StudioProps) {
  const [sessions, setSessions] = useState<StudioSession[] | null>(null);
  const [goal, setGoal] = useState('');
  const [platform, setPlatform] = useState('dsh');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listStudioSessions()
      .then(setSessions)
      .catch(() => setError('创造会话加载失败'));
  }, []);

  async function create() {
    if (!goal.trim()) {
      setError('请填写目标');
      return;
    }
    setError(null);
    try {
      const session = await createStudioSession({ goal: goal.trim(), platform });
      setSessions((current) => [session, ...(current ?? [])]);
      setGoal('');
    } catch {
      setError('创建失败');
    }
  }

  async function submit(id: string) {
    setError(null);
    try {
      const updated = await submitStudioSession(id);
      setSessions((current) => current?.map((item) => (item.id === id ? updated : item)) ?? current);
    } catch {
      setError('提交失败');
    }
  }

  async function review(id: string, decision: 'approve' | 'reject') {
    setError(null);
    try {
      const updated = await reviewStudioSession(id, decision);
      setSessions((current) => current?.map((item) => (item.id === id ? updated : item)) ?? current);
    } catch {
      setError('审批失败');
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">OpsAgent</div>
        <div className="tenant">
          <strong>创造模式</strong>
          <span>生成 → 测试 → 审核</span>
        </div>
        <button type="button" onClick={onBack}>返回工作台</button>
      </aside>
      <main className="page">
        <header>
          <div className="eyebrow">Studio</div>
          <h1>创造模式</h1>
        </header>
        {error ? <p role="alert">{error}</p> : null}
        <section className="card">
          <h2>新建会话</h2>
          <label htmlFor="studio-goal">目标</label>
          <input id="studio-goal" value={goal} onChange={(event) => setGoal(event.target.value)} />
          <label htmlFor="studio-platform">平台</label>
          <input
            id="studio-platform"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          />
          <button type="button" onClick={() => void create()}>生成</button>
        </section>
        {sessions === null ? <p className="muted">加载中…</p> : null}
        {sessions?.length === 0 ? <p className="muted">暂无创造会话</p> : null}
        <section className="cards">
          {sessions?.map((session) => (
            <article key={session.id} className="card">
              <h2>{session.goal}</h2>
              <p className="muted">{session.platform} · {session.status}</p>
              {session.bundle ? <p className="muted">{session.bundle.files.length} files</p> : null}
              {session.status === 'generated' ? (
                <button type="button" onClick={() => void submit(session.id)}>提交审核</button>
              ) : null}
              {session.status === 'pending_review' ? (
                <div>
                  <button type="button" onClick={() => void review(session.id, 'approve')}>通过</button>
                  <button type="button" onClick={() => void review(session.id, 'reject')}>拒绝</button>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
