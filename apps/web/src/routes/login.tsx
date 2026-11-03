import { useState, type FormEvent } from 'react';
import { loginLocalAdmin } from '../api/client.js';

export interface LoginProps {
  readonly onSuccess: () => void;
}

export function Login({ onSuccess }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginLocalAdmin(username, password);
      onSuccess();
    } catch {
      setError('用户名或密码错误');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section className="card">
        <div className="eyebrow">OpsAgent · AIOps Control Plane</div>
        <h1>登录运维智能体平台</h1>
        <p className="muted">使用 LDAP 或本地管理员账号。本地管理员仅用于 break-glass。</p>
        <form onSubmit={submit}>
          <label htmlFor="username">用户名</label>
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
          <label htmlFor="password">密码</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={busy}>
            登录
          </button>
        </form>
      </section>
    </main>
  );
}
