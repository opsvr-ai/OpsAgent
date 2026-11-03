import { useEffect, useState } from 'react';
import { listMembers, setMemberRoles, type MemberSummary } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface MembersProps {
  readonly onBack: () => void;
}

const ROLES = [
  'tenant_admin',
  'sre_duty',
  'dba',
  'container_platform',
  'network',
  'change_manager',
  'knowledge_admin',
  'auditor',
  'readonly_observer',
];

export function Members({ onBack }: MembersProps) {
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

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
      eyebrow="Members"
      title="成员与角色"
      subtitle="多角色并集；视角切换不放大权限。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      {members === null ? <p className="muted">加载中…</p> : null}
      <section className="stack">
        {members?.map((member) => (
          <article key={member.userId} className="card">
            <div className="card-body">
              <div className="row-between">
                <h3>{member.displayName} · {member.username}</h3>
                <span className="badge badge-neutral">{member.status}</span>
              </div>
              <div className="role-grid">
                {ROLES.map((role) => (
                  <label key={role} className="checkline">
                    <input
                      type="checkbox"
                      checked={(draft[member.userId] ?? []).includes(role)}
                      onChange={() => toggle(member.userId, role)}
                    />
                    {role}
                  </label>
                ))}
              </div>
              <button type="button" className="btn btn-primary" onClick={() => void save(member.userId)}>保存角色</button>
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
