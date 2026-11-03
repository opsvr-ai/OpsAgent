import { useEffect, useState } from 'react';
import { listMembers, setMemberRoles, type MemberSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface MembersProps {
  readonly onBack: () => void;
}

const ROLES: Array<{ id: string; description: string }> = [
  { id: 'tenant_admin', description: '租户治理、成员管理与全部配置' },
  { id: 'sre_duty', description: '事件响应、场景执行与审批' },
  { id: 'dba', description: '数据库连接器与只读查询' },
  { id: 'container_platform', description: '容器平台与发布操作' },
  { id: 'network', description: '网络与流量相关操作' },
  { id: 'change_manager', description: '变更审批与发布把关' },
  { id: 'knowledge_admin', description: '知识审核与发布' },
  { id: 'auditor', description: '只读审计与导出' },
  { id: 'readonly_observer', description: '只读观察，不执行工具' },
];

const ROLE_LABELS: Record<string, string> = {
  tenant_admin: '租户管理员',
  sre_duty: '值班 SRE',
  dba: 'DBA',
  container_platform: '容器平台',
  network: '网络',
  change_manager: '变更经理',
  knowledge_admin: '知识管理员',
  auditor: '审计员',
  readonly_observer: '只读观察者',
};

export function Members({ onBack }: MembersProps) {
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [tab, setTab] = useState<'members' | 'roles' | 'boundary'>('members');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void listMembers()
      .then((items) => {
        setMembers(items);
        setDraft(Object.fromEntries(items.map((item) => [item.userId, [...item.roles]])));
      })
      .catch(() => setError('成员加载失败'));
  }, []);

  async function save(userId: string) {
    setError(null);
    try {
      const updated = await setMemberRoles(userId, draft[userId] ?? []);
      setMembers((current) => current?.map((item) => (item.userId === userId ? updated : item)) ?? current);
      setEditing(null);
      setMessage('角色已更新');
    } catch {
      setError('保存角色失败');
    }
  }

  function toggle(userId: string, role: string) {
    setDraft((current) => {
      const roles = current[userId] ?? [];
      return {
        ...current,
        [userId]: roles.includes(role) ? roles.filter((item) => item !== role) : [...roles, role],
      };
    });
  }

  return (
    <DesignShell
      active="members"
      eyebrow="Tenant governance · 租户管理员"
      title="成员与角色"
      subtitle="多角色并集；视角切换不放大权限。"
      onBack={onBack}
      actions={
        <>
          <button type="button" className="btn btn-outline" disabled title="开发环境未配置 LDAP">同步 LDAP</button>
          <button type="button" className="btn btn-outline" disabled title="内置角色只读">新建角色</button>
        </>
      }
    >
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}
      <div className="status-strip" style={{ marginBottom: 20 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-users" /></svg></span><div><strong>租户成员</strong><span>{members?.length ?? 0} 人</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已激活</strong><span>{members?.filter((item) => item.status === 'active').length ?? 0} 人</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>租户管理员</strong><span>{members?.filter((item) => item.roles.includes('tenant_admin')).length ?? 0} 人</span></div></div>
      </div>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button type="button" className={`tab${tab === 'members' ? ' is-active' : ''}`} onClick={() => setTab('members')}>成员<span className="count">{members?.length ?? 0}</span></button>
        <button type="button" className={`tab${tab === 'roles' ? ' is-active' : ''}`} onClick={() => setTab('roles')}>角色矩阵<span className="count">{ROLES.length}</span></button>
        <button type="button" className={`tab${tab === 'boundary' ? ' is-active' : ''}`} onClick={() => setTab('boundary')}>租户边界</button>
      </div>
      {tab === 'members' ? (
        <>
      <section className="card">
        <div className="card-head">
          <h2>成员</h2>
          <span className="muted">{members?.length ?? 0} 位成员</span>
        </div>
        <div className="card-body">
          {members === null ? <p className="muted">加载中…</p> : null}
          {members && members.length > 0 ? (
            <table className="table">
              <thead><tr><th>成员</th><th>账号</th><th>状态</th><th>角色</th><th /></tr></thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId} className={editing === member.userId ? 'is-clickable' : ''}>
                    <td className="cell-main">{member.displayName}</td>
                    <td className="mono">{member.username}</td>
                    <td><span className="badge badge-neutral">{member.status}</span></td>
                    <td>
                      <div className="role-chips">
                        {member.roles.map((role) => (
                          <span key={role} className="badge badge-neutral" title={role}>{ROLE_LABELS[role] ?? role}</span>
                        ))}
                      </div>
                    </td>
                    <td className="actions-cell">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing(editing === member.userId ? null : member.userId)}>
                        {editing === member.userId ? '收起' : '编辑角色'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      {editing ? (
        <section className="card">
          <div className="card-head">
            <h2>编辑角色</h2>
            <span className="muted">{members?.find((item) => item.userId === editing)?.username}</span>
          </div>
          <div className="card-body">
            <div className="role-grid">
              {ROLES.map((role) => (
                <label key={role.id} className="checkline role-option">
                  <input
                    type="checkbox"
                    checked={(draft[editing] ?? []).includes(role.id)}
                    onChange={() => toggle(editing, role.id)}
                  />
                  <span>
                    <strong>{role.id}</strong>
                    <span className="muted">{role.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => void save(editing)}>保存角色</button>
              <button type="button" className="btn btn-outline" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        </section>
      ) : null}
        </>
      ) : null}

      {tab === 'roles' ? (
        <section className="card">
          <div className="card-head"><h2>角色矩阵</h2><span className="badge badge-neutral">内置 9 角色</span></div>
          <div className="card-body">
            <table className="table">
              <thead><tr><th>角色</th><th>标识</th><th>说明</th></tr></thead>
              <tbody>
                {ROLES.map((role) => (
                  <tr key={role.id}><td>{ROLE_LABELS[role.id] ?? role.id}</td><td className="mono">{role.id}</td><td className="muted">{role.description}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === 'boundary' ? (
        <section className="grid grid-2">
          <article className="card">
            <div className="card-head"><h2>LDAP 同步</h2><span className="badge badge-warn">开发环境未配置</span></div>
            <div className="card-body">
              <p className="muted">开发环境使用本地管理员登录。生产接入 LDAP 后，成员由目录同步，角色仍在平台内分配。</p>
            </div>
          </article>
          <article className="card">
            <div className="card-head"><h2>租户边界</h2><span className="badge badge-ok">已启用</span></div>
            <div className="card-body">
              <p className="muted">成员关系和角色都只对当前租户生效；平台管理员不能读取租户会话正文。</p>
            </div>
          </article>
        </section>
      ) : null}
    </DesignShell>
  );
}
