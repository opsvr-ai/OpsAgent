import { DesignShell } from './design-shell.js';
import { useTheme } from '../theme/use-theme.js';
import type { ThemeMode } from '../theme/types.js';

export interface AppearanceProps {
  readonly onBack: () => void;
}

const OPTIONS: Array<{ mode: ThemeMode; title: string; description: string }> = [
  { mode: 'light', title: '浅色', description: '始终浅色' },
  { mode: 'dark', title: '深色', description: '始终深色' },
  { mode: 'system', title: '跟随系统', description: '使用操作系统偏好' },
  { mode: 'time', title: '时间自适应', description: '白天浅色，夜间深色' },
];

export function Appearance({ onBack }: AppearanceProps) {
  const { mode, setMode } = useTheme();

  return (
    <DesignShell
      active="appearance"
      eyebrow="Preferences · 用户偏好"
      title="外观与主题"
      subtitle="自动模式只决定解析成浅色还是深色，不改变优先级。"
      onBack={onBack}
      actions={
        <>
          <button type="button" className="btn btn-outline">恢复租户默认</button>
          <button type="button" className="btn btn-primary">保存偏好</button>
        </>
      }
    >
      <div className="notice-line" style={{ marginBottom: 16 }}>
        当前生效：{mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : mode === 'system' ? '跟随系统' : '时间自适应'}。自动模式只影响浅色 / 深色解析，不会改变优先级。
      </div>
      <section className="grid grid-4">
        {OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={mode === option.mode ? 'card theme-card is-selected' : 'card theme-card'}
            onClick={() => setMode(option.mode)}
          >
            <div className="card-body">
              <span className="badge badge-neutral">{mode === option.mode ? '已选择' : '选择'}</span>
              <div className={`theme-swatch is-${option.mode}`}>
                <span className="swatch-side" />
                <span className="swatch-main"><i /><i /><i /></span>
              </div>
              <h3>{option.title}</h3>
              <p className="muted">{option.description}</p>
            </div>
          </button>
        ))}
      </section>
      <section className="grid grid-2">
        <article className="card">
          <div className="card-body">
            <div className="row-between">
              <h2>时间自适应</h2>
              <span className="badge badge-neutral">{mode === 'time' ? '已启用' : '未启用'}</span>
            </div>
            <div className="row-sm">
              <label htmlFor="light-start">浅色窗口</label>
              <input id="light-start" type="time" defaultValue="07:00" />
              <span>至</span>
              <input type="time" aria-label="浅色结束" defaultValue="19:00" />
              <select aria-label="时区" defaultValue="Asia/Shanghai">
                <option>Asia/Shanghai</option>
                <option>UTC</option>
              </select>
            </div>
            <p className="muted">窗口内使用浅色，窗口外使用深色；每分钟检查一次。</p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <h2>生效优先级</h2>
            <ol className="priority-list muted">
              <li><span>1</span>当前会话临时切换</li>
              <li><span>2</span>用户默认</li>
              <li><span>3</span>租户默认</li>
              <li><span>4</span>平台默认</li>
            </ol>
            <p className="muted">自动模式只决定解析成浅色还是深色，不改变优先级。</p>
          </div>
        </article>
      </section>

      <section className="card">
        <div className="card-head"><h2>快速预览</h2><span className="muted">打开对应主题的工作台</span></div>
        <div className="card-body row-sm">
          <button type="button" className="btn btn-outline" onClick={() => setMode('light')}>浅色工作台</button>
          <button type="button" className="btn btn-outline" onClick={() => setMode('dark')}>深色工作台</button>
          <button type="button" className="btn btn-ghost" onClick={() => window.dispatchEvent(new CustomEvent('opsagent:navigate', { detail: 'home' }))}>返回工作台</button>
        </div>
      </section>
    </DesignShell>
  );
}
