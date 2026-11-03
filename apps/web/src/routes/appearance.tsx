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
      active="home"
      eyebrow="Preferences · 用户偏好"
      title="外观与主题"
      subtitle="自动模式只决定解析成浅色还是深色，不改变优先级。"
      onBack={onBack}
    >
      <section className="grid grid-2">
        {OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={mode === option.mode ? 'card theme-card is-selected' : 'card theme-card'}
            onClick={() => setMode(option.mode)}
          >
            <div className="card-body">
              <span className="badge badge-neutral">{mode === option.mode ? '已选择' : '选择'}</span>
              <h3>{option.title}</h3>
              <p className="muted">{option.description}</p>
            </div>
          </button>
        ))}
      </section>
      <section className="card">
        <div className="card-body">
          <h2>生效优先级</h2>
          <p className="muted">URL 参数 → 用户偏好 → 租户默认 → 系统偏好</p>
          <p className="muted">首屏注入 data-theme，避免刷新闪烁。</p>
        </div>
      </section>
    </DesignShell>
  );
}
