export const THEME_MODES = ['light', 'dark', 'system', 'time'] as const;

export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = 'light' | 'dark';

export interface ThemePreference {
  readonly mode: ThemeMode;
  readonly timeLightStart: string;
  readonly timeLightEnd: string;
}

export const DEFAULT_THEME_PREFERENCE: ThemePreference = {
  mode: 'light',
  timeLightStart: '07:00',
  timeLightEnd: '19:00',
};

export function isThemeMode(value: string): value is ThemeMode {
  return (THEME_MODES as readonly string[]).includes(value);
}
