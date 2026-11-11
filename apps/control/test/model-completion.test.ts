import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCompletionService } from '../src/models/completion.js';
import type { ModelProviderService } from '../src/models/service.js';

function models(provider: string, baseUrl: string): ModelProviderService {
  return {
    resolve: vi.fn().mockResolvedValue({
      provider,
      baseUrl,
      model: 'test-model',
      apiKey: 'test-key',
    }),
  } as unknown as ModelProviderService;
}

describe('model completion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls an OpenAI-compatible chat completions endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OpenAI answer' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const completion = new ModelCompletionService(models('openai', 'https://llm.example'));
    const answer = await completion.complete({
      tenantId: 't',
      system: 'system',
      prompt: 'prompt',
    });
    expect(answer).toBe('OpenAI answer');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://llm.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('calls an Anthropic messages endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Anthropic answer' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const completion = new ModelCompletionService(models('anthropic', 'https://api.anthropic.com'));
    const answer = await completion.complete({
      tenantId: 't',
      system: 'system',
      prompt: 'prompt',
    });
    expect(answer).toBe('Anthropic answer');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
  });

  it('retries with a minimal payload when the gateway rejects optional params', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: 'unsupported max_tokens' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'retry ok' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const completion = new ModelCompletionService(models('openai', 'https://llm.example/v1'));
    const answer = await completion.complete({
      tenantId: 't',
      system: 'system',
      prompt: 'prompt',
      maxTokens: 64,
    });
    expect(answer).toBe('retry ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string) as {
      model: string;
      messages: unknown[];
      temperature?: unknown;
      max_tokens?: unknown;
    };
    expect(retryBody).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'prompt' },
      ],
    });
  });
});
