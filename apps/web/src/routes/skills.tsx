import { useEffect, useState } from 'react';
import {
  assignAgentSkill,
  createAgentSkill,
  deleteAgentSkill,
  listAgentSkills,
  listAppSystems,
  listAgents,
  type AgentSkill,
  type AgentSummary,
  type AppSystemSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface SkillsProps {
  readonly onBack: () => void;
}

export function Skills({ onBack }: SkillsProps) {
  const [skills, setSkills] = useState<AgentSkill[] | null>(null);
  const [systems, setSystems] = useState<AppSystemSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'app_system' | 'agent'>('all');
  const [targetId, setTargetId] = useState('');

  async function reload() {
    setSkills(await listAgentSkills());
    setSystems(await listAppSystems());
    setAgents(await listAgents());
  }
  useEffect(() => {
    void reload().catch(() => setNote('技能加载失败'));
  }, []);

  async function create() {
    if (!name.trim() || !content.trim()) {
      setNote('请填写技能名称和内容');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await createAgentSkill({ name: name.trim(), description: description.trim(), content });
      setName('');
      setDescription('');
      setContent('');
      await reload();
      setNote('自定义技能已创建');
    } catch {
      setNote('创建失败，技能名不能与内置技能冲突');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('删除这个自定义技能？')) return;
    try {
      await deleteAgentSkill(id);
      await reload();
    } catch {
      setNote('删除失败');
    }
  }

  async function sync(skill: AgentSkill) {
    setBusy(true);
    setNote(null);
    try {
      const result = await assignAgentSkill(skill.id, {
        scope,
        ...(scope !== 'all' && targetId ? { targetId } : {}),
      });
      setNote(`已同步到 ${result.synced} 台主机`);
      await reload();
      setAssigning(null);
    } catch {
      setNote('同步失败，请选择有效的目标');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DesignShell
      active="skills"
      eyebrow="Operations skills"
      title="运维技能"
      subtitle="内置技能由 Agent 自动上报并同步；自定义技能可下发到全部主机、应用系统或指定主机。"
      onBack={onBack}
    >
      <section className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>新增自定义技能</h2><span className="muted">SKILL.md 格式</span></div>
          <div className="card-body stack">
            <div className="field"><label htmlFor="skill-name">技能名</label><input id="skill-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="my-ops-check" /></div>
            <div className="field"><label htmlFor="skill-desc">描述</label><input id="skill-desc" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="检查业务应用端口与日志" /></div>
            <div className="field"><label htmlFor="skill-content">技能内容</label><textarea id="skill-content" rows={7} value={content} onChange={(event) => setContent(event.target.value)} placeholder={'---\nname: my-ops-check\ndescription: ...\n---\n# 检查步骤\n...'} /></div>
            <div className="form-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>{busy ? '处理中…' : '创建技能'}</button>{note ? <span className="muted">{note}</span> : null}</div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>下发目标</h2></div>
          <div className="card-body stack">
            <div className="field"><label htmlFor="skill-scope">范围</label>
              <select id="skill-scope" value={scope} onChange={(event) => { setScope(event.target.value as typeof scope); setTargetId(''); }}>
                <option value="all">全部在线主机</option>
                <option value="app_system">指定应用系统</option>
                <option value="agent">指定主机</option>
              </select>
            </div>
            {scope === 'app_system' ? <div className="field"><label htmlFor="skill-system">应用系统</label><select id="skill-system" value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">选择应用系统</option>{systems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div> : null}
            {scope === 'agent' ? <div className="field"><label htmlFor="skill-agent">主机</label><select id="skill-agent" value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">选择主机</option>{agents.map((item) => <option key={item.id} value={item.id}>{item.hostname}</option>)}</select></div> : null}
            <p className="muted">下发后 Agent 会写入 `/opt/opsagent/skills/&lt;name&gt;/SKILL.md`，下一次对话即可使用。</p>
          </div>
        </div>
      </section>

      <section className="grid grid-3">
        {skills?.map((skill) => (
          <article key={skill.id} className="card">
            <div className="card-body stack">
              <div><span className={`badge ${skill.source === 'builtin' ? 'badge-info' : 'badge-ok'}`}>{skill.source === 'builtin' ? '内置' : '自定义'}</span> <span className="badge badge-neutral">v{skill.version}</span></div>
              <h3 className="mono">{skill.name}</h3>
              <p className="muted">{skill.description || '无描述'}</p>
              <p className="muted">已下发：{skill.assignments.length > 0 ? skill.assignments.map((item) => item.targetName ?? item.scope).join('、') : '未下发'}</p>
              <div className="row-sm">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setAssigning(skill.id)}>同步</button>
                {skill.source === 'custom' ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(skill.id)}>删除</button> : null}
              </div>
              {assigning === skill.id ? <div className="form-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void sync(skill)}>确认同步</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setAssigning(null)}>取消</button></div> : null}
            </div>
          </article>
        ))}
      </section>
      {skills?.length === 0 ? <p className="muted">暂无技能，等待 Agent 上报内置技能。</p> : null}
    </DesignShell>
  );
}
