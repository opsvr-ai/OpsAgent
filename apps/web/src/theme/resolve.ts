import type { ResolvedTheme, ThemeMode } from './types.js';

export function resolveTheme(mode: ThemeMode, now = new Date()): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  if (mode === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const hour = now.getHours();
  return hour >= 7 && hour < 19 ? 'light' : 'dark';
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
