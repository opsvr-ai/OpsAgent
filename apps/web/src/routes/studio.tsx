import { useEffect, useState } from 'react';
import {
  createStudioSession,
  listStudioSessions,
  reviewStudioSession,
  submitStudioSession,
  type StudioSession,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface StudioProps {
  readonly onBack: () => void;
}

export function Studio({ onBack }: StudioProps) {
  const [sessions, setSessions] = useState<StudioSession[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [platform, setPlatform] = useState('dsh');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listStudioSessions()
      .then((items) => {
        setSessions(items);
        setSelectedId(items[0]?.id ?? null);
      })
      .catch(() => setError('创造会话加载失败'));
  }, []);

  const selected = sessions?.find((item) => item.id === selectedId) ?? null;

  function replace(updated: StudioSession): void {
    setSessions((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current);
  }

  async function create() {
    if (!goal.trim()) {
      setError('请填写目标');
      return;
    }
    setError(null);
    try {
      const session = await createStudioSession({ goal: goal.trim(), platform });
      setSessions((current) => [session, ...(current ?? [])]);
      setSelectedId(session.id);
      setGoal('');
    } catch {
      setError('创建失败');
    }
  }

  async function submit(id: string) {
    setError(null);
    try {
      replace(await submitStudioSession(id));
    } catch {
      setError('提交失败');
    }
  }

  async function review(id: string, decision: 'approve' | 'reject') {
    setError(null);
    try {
      replace(await reviewStudioSession(id, decision));
    } catch {
      setError('审批失败');
    }
  }

  return (
    <DesignShell
      active="studio"
      eyebrow="Studio"
      title="创造模式"
      subtitle="用 dsh 生成连接器 bundle，经过测试与审核后发布。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      {selected ? (
        <div className="status-strip" style={{ marginBottom: 18 }}>
          <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-wand" /></svg></span><div><strong>目标</strong><span>{selected.goal}</span></div></div>
          <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-plug" /></svg></span><div><strong>平台</strong><span>{selected.platform}</span></div></div>
          <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>生成文件</strong><span>{selected.bundle?.files.length ?? 0} 个</span></div></div>
          <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>状态</strong><span>{selected.status}</span></div></div>
        </div>
      ) : null}
      <div className="studio-grid">
        <section className="studio-pane">
          <div className="studio-pane-head">
            <strong>会话</strong>
            <span className="badge badge-neutral">{sessions?.length ?? 0}</span>
          </div>
          <div className="studio-pane-body">
            {sessions === null ? <p className="muted" style={{ padding: 12 }}>加载中…</p> : null}
            {sessions?.length === 0 ? <p className="muted" style={{ padding: 12 }}>暂无创造会话</p> : null}
            {sessions?.map((session) => (
              <button
                key={session.id}
                type="button"
                className={`studio-list-item${session.id === selectedId ? ' is-active' : ''}`}
                onClick={() => setSelectedId(session.id)}
              >
                <strong>{session.goal}</strong>
                <span>{session.platform} · {session.status}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="studio-pane">
          <div className="studio-pane-head">
            <strong>生成记录</strong>
            {selected ? <span className="badge badge-neutral">{selected.status}</span> : null}
          </div>
          <div className="studio-pane-body">
            {selected ? (
              <>
                <div className="studio-msg is-user">
                  <div className="who">目标 · {selected.platform}</div>
                  {selected.goal}
                </div>
                <div className="studio-msg">
                  <div className="who">OpsAgent</div>
                  {selected.bundle
                    ? `已生成 ${selected.bundle.files.length} 个文件，等待测试与审核。`
                    : '会话已创建，尚未生成 bundle。'}
                </div>
                {selected.bundle ? (
                  <div className="studio-msg">
                    <div className="who">bundle 文件</div>
                    {selected.bundle.files.map((file) => (
                      <div key={file} className="file-row"><span className="mono">{file}</span></div>
                    ))}
                    <pre className="metric-code" style={{ marginTop: 8 }}>{JSON.stringify(selected.bundle.manifest, null, 2)}</pre>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted" style={{ padding: 12 }}>选择或新建一个会话</p>
            )}
          </div>
        </section>

        <section className="studio-pane">
          <div className="studio-pane-head"><strong>生成与审核</strong></div>
          <div className="studio-pane-body" style={{ padding: 12 }}>
            <div className="field">
              <label htmlFor="studio-goal">目标</label>
              <input id="studio-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="例如 生成 BlueKing CMDB 连接器" />
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor="studio-platform">平台</label>
              <input id="studio-platform" value={platform} onChange={(event) => setPlatform(event.target.value)} />
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void create()}>生成</button>
            {selected?.status === 'generated' ? (
              <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => void submit(selected.id)}>提交审核</button>
            ) : null}
            {selected?.status === 'pending_review' ? (
              <div className="row-sm" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-primary" onClick={() => void review(selected.id, 'approve')}>通过</button>
                <button type="button" className="btn btn-outline" onClick={() => void review(selected.id, 'reject')}>拒绝</button>
              </div>
            ) : null}
            <p className="muted" style={{ marginTop: 14 }}>生成结果不会直接发布；需提交审核并通过后才进入租户目录。</p>
          </div>
        </section>
      </div>
    </DesignShell>
  );
}
