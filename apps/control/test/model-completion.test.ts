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
});
