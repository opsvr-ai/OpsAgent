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
    <div className="login">
      <section className="login-visual">
        <div className="login-brand">
          <div className="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7l5 5-5 5" />
              <path d="M12 17h8" />
            </svg>
          </div>
          <strong>OpsAgent</strong>
          <span className="env-pill" style={{ marginLeft: 8 }}>
            <span className="dot dot-ok" style={{ width: 5, height: 5 }} />
            多租户运维智能体
          </span>
        </div>

        <div className="login-hero">
          <div className="eyebrow">Operations intelligence · 运维智能体平台</div>
          <h1>
            从告警到根因，
            <br />
            <em>一条会话完成。</em>
          </h1>
          <p>
            把 Zabbix、Prometheus、Kubernetes 与自有运维平台接入同一个智能体工作台。
            每次工具调用都在租户边界、角色权限与审计记录之内。
          </p>
          <div className="login-facts">
            <div className="login-fact"><strong>9</strong><span>标准连接器<br />开箱即用</span></div>
            <div className="login-fact"><strong>R0–R3</strong><span>风险分级<br />审批闭环</span></div>
            <div className="login-fact"><strong>100%</strong><span>租户数据<br />独立隔离</span></div>
          </div>
        </div>

        <div className="login-log">
          <div><span className="ok">●</span> <span className="key">runtime</span> dsh · profile opsagent-runtime</div>
          <div><span className="ok">●</span> <span className="key">policy</span> tenant isolation enforced · audit streaming</div>
          <div><span className="ok">●</span> <span className="key">approval</span> R2/R3 human-in-the-loop</div>
        </div>
      </section>

      <section className="login-form-side">
        <form className="login-form" onSubmit={submit}>
          <div className="eyebrow">企业账号登录</div>
          <h2>登录 OpsAgent</h2>
          <p className="sub">
            使用本地管理员账号进入开发环境；生产环境通过 LDAP 登录，租户与角色由平台管理员分配。
          </p>

          <div className="field">
            <label htmlFor="username">用户名</label>
            <input
              className="input"
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              className="input"
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {error ? <p role="alert">{error}</p> : null}

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>

          <div className="login-help">
            首次登录会同步用户信息，但不会自动授予租户权限。开发环境默认账号见 README。
          </div>
          <div className="login-footer">OpsAgent · dsh · 仅限授权人员使用</div>
        </form>
      </section>
    </div>
  );
}
