import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Knowledge } from '../src/routes/knowledge.js';
import { listKnowledge, publishKnowledge } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listKnowledge: vi.fn(),
  createKnowledge: vi.fn(),
  publishKnowledge: vi.fn(),
}));

const listMock = vi.mocked(listKnowledge);
const publishMock = vi.mocked(publishKnowledge);

describe('Knowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists documents and publishes one', async () => {
    listMock.mockResolvedValue([
      { id: 'k-1', title: '连接池排查', body: '检查等待队列', status: 'draft' },
    ]);
    publishMock.mockResolvedValue({
      id: 'k-1',
      title: '连接池排查',
      body: '检查等待队列',
      status: 'published',
    });
    render(<Knowledge onBack={vi.fn()} />);
    expect(await screen.findByText('连接池排查')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(publishMock).toHaveBeenCalledWith('k-1'));
    expect(await screen.findByText('published')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<Knowledge onBack={vi.fn()} />);
    expect(await screen.findByText('暂无知识')).toBeInTheDocument();
  });
});
