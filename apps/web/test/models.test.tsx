import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Models } from '../src/routes/models.js';
import { listModels } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listModels: vi.fn(),
  createModel: vi.fn(),
  deleteModel: vi.fn(),
}));

const listMock = vi.mocked(listModels);

describe('Models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists model providers', async () => {
    listMock.mockResolvedValue([
      {
        id: 'm-1',
        name: 'deepseek-prod',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        status: 'active',
      },
    ]);
    render(<Models onBack={vi.fn()} />);
    expect(await screen.findByText('deepseek-prod')).toBeInTheDocument();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Models onBack={vi.fn()} />);
    expect(await screen.findByText('暂无模型配置')).toBeInTheDocument();
  });
});
