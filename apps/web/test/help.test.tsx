import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Help } from '../src/routes/help.js';

describe('Help', () => {
  it('renders the integrated user manual', () => {
    render(<Help onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '用户手册' })).toBeInTheDocument();
    expect(screen.getAllByText('快速开始').length).toBeGreaterThan(0);
    expect(screen.getByText('发布与灰度')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /一键安装/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /证书、CRL 与 OCSP/ })).toBeInTheDocument();
  });
});
