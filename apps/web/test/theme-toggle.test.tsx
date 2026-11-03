import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from '../src/theme/use-theme.js';

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('opsagent.theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });

  it('toggles between light and dark', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: '切换主题' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '切换主题' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
