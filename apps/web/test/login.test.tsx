import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Login } from '../src/routes/login.js';

describe('Login', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('submits credentials and calls onSuccess', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    render(<Login onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'tenant-admin' } });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
  });

  it('shows an error for invalid credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_credentials' }), { status: 401 })),
    );

    render(<Login onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'tenant-admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误');
  });
});
