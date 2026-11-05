import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Models } from '../src/routes/models.js';
import { createModelsBatch, discoverModels, listModels } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listModels: vi.fn(),
  createModel: vi.fn(),
  createModelsBatch: vi.fn(),
  discoverModels: vi.fn().mockResolvedValue([]),
  deleteModel: vi.fn(),
}));

const listMock = vi.mocked(listModels);
const batchMock = vi.mocked(createModelsBatch);
const discoverMock = vi.mocked(discoverModels);

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

  it('discovers and saves multiple models for one URL', async () => {
    listMock.mockResolvedValue([]);
    discoverMock.mockResolvedValue([
      { id: 'qwen-72b' },
      { id: 'qwen-32b', displayName: 'Qwen 32B' },
    ]);
    batchMock.mockResolvedValue([]);
    render(<Models onBack={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Base URL'), { target: { value: 'https://llm.example/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: '发现模型' }));

    expect(await screen.findByText('Qwen 32B')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /保存 2 个模型/ }));

    await waitFor(() => expect(batchMock).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://llm.example/v1',
      models: ['qwen-72b', 'qwen-32b'],
    })));
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Models onBack={vi.fn()} />);
    expect(await screen.findByText('暂无模型配置')).toBeInTheDocument();
  });
});
