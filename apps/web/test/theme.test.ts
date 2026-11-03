import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../src/theme/resolve.js';

function withSystemDark(dark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({ matches: dark, addEventListener: () => undefined }),
  });
}

describe('theme resolver', () => {
  it('uses explicit light and dark modes', () => {
    expect(resolveTheme('light', new Date('2026-11-03T20:00:00+08:00'))).toBe('light');
    expect(resolveTheme('dark', new Date('2026-11-03T08:00:00+08:00'))).toBe('dark');
  });

  it('follows the system preference', () => {
    withSystemDark(true);
    expect(resolveTheme('system', new Date())).toBe('dark');
    withSystemDark(false);
    expect(resolveTheme('system', new Date())).toBe('light');
  });

  it('uses the 07:00–19:00 light window for time mode', () => {
    expect(resolveTheme('time', new Date('2026-11-03T08:00:00+08:00'))).toBe('light');
    expect(resolveTheme('time', new Date('2026-11-03T18:59:00+08:00'))).toBe('light');
    expect(resolveTheme('time', new Date('2026-11-03T20:00:00+08:00'))).toBe('dark');
  });
});
