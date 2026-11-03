import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Appearance } from '../src/routes/appearance.js';

describe('Appearance', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('selects a theme mode', () => {
    render(<Appearance onBack={vi.fn()} />);
    fireEvent.click(screen.getByText('深色'));
    expect(localStorage.getItem('opsagent.theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
