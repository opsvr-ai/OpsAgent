import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from '../src/routes/chat.js';
import { decideApproval, listAvailableModels, promptSession } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  promptSession: vi.fn(),
  decideApproval: vi.fn(),
  listApprovals: vi.fn().mockResolvedValue([]),
  listAvailableModels: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionTranscript: vi.fn().mockResolvedValue([]),
}));

const promptMock = vi.mocked(promptSession);
const decideMock = vi.mocked(decideApproval);
const modelsMock = vi.mocked(listAvailableModels);

describe('Chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams events and shows the tool result', async () => {
    promptMock.mockImplementation(async function* () {
      yield { type: 'assistant.delta', sessionId: 's', at: 't', text: 'checking' };
      yield { type: 'tool.call', sessionId: 's', at: 't', tool: 'mock.echo', args: {}, risk: 'R0' };
      yield { type: 'tool.result', sessionId: 's', at: 't', tool: 'mock.echo', result: {} };
      yield { type: 'session.done', sessionId: 's', at: 't' };
    });

    render(<Chat sessionId="s" roleView="sre_duty" onBack={vi.fn()} onOpenSession={vi.fn()} onNewSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('输入')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('输入'), { target: { value: 'echo hello' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('checking')).toBeInTheDocument();
    expect(screen.getAllByText(/mock\.echo/).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('完成')).length).toBeGreaterThan(0);
  });

  it('asks for approval and submits the decision', async () => {
    promptMock.mockImplementation(async function* () {
      yield { type: 'assistant.delta', sessionId: 's', at: 't', text: 'need approval' };
      yield {
        type: 'approval.request',
        sessionId: 's',
        at: 't',
        approvalId: 'a-1',
        action: 'mock.restart',
        risk: 'R2',
      };
    });
    decideMock.mockResolvedValue(undefined);

    render(<Chat sessionId="s" roleView="sre_duty" onBack={vi.fn()} onOpenSession={vi.fn()} onNewSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('输入')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('输入'), { target: { value: 'restart' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    fireEvent.click(await screen.findByRole('button', { name: '批准' }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith('a-1', 'approve'));
  });

  it('sends the selected model id with the prompt', async () => {
    modelsMock.mockResolvedValue([
      { id: 'm1', name: '默认模型', provider: 'deepseek', baseUrl: 'https://api.example', model: 'deepseek-chat', status: 'active', isAgentDefault: false },
      { id: 'm2', name: '内网模型', provider: 'openai', baseUrl: 'https://llm.example', model: 'qwen-prod', status: 'active', isAgentDefault: false },
    ]);
    promptMock.mockImplementation(async function* () {
      yield { type: 'session.done', sessionId: 's', at: 't' };
    });

    render(<Chat sessionId="s" roleView="sre_duty" onBack={vi.fn()} onOpenSession={vi.fn()} onNewSession={vi.fn()} />);
    const modelSelect = await screen.findByLabelText('模型');
    fireEvent.change(modelSelect, { target: { value: 'm2' } });
    await waitFor(() => expect(screen.getByLabelText('输入')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('输入'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(promptMock).toHaveBeenCalledWith(
      's',
      'hello',
      expect.any(String),
      'auto-review',
      'm2',
    ));
  });
});
