import { useEffect, useState } from 'react';
import type { ThemeMode } from './types.js';
import { applyTheme, resolveTheme } from './resolve.js';

const STORAGE_KEY = 'opsagent.theme';

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' || stored === 'time'
      ? stored
      : 'time';
  });

  useEffect(() => {
    applyTheme(resolveTheme(mode));
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return {
    mode,
    setMode,
    toggle() {
      setMode((current) => (resolveTheme(current) === 'dark' ? 'light' : 'dark'));
    },
  };
}

export function ThemeToggle() {
  const { toggle } = useTheme();
  return (
    <button type="button" className="btn btn-outline" onClick={toggle} aria-label="切换主题">
      <svg><use href="/icons.svg#i-sun" /></svg>
      主题
    </button>
  );
}
