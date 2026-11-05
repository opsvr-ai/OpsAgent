import { describe, expect, it, vi } from 'vitest';
import { discoverModels } from '../src/models/discovery.js';

describe('model discovery', () => {
  it('discovers OpenAI-compatible models and sends bearer auth', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'gpt-4.1' },
        { id: 'gpt-4.1-mini', display_name: 'GPT 4.1 mini' },
        { id: 'gpt-4.1' },
      ],
    }), { status: 200 }));

    const models = await discoverModels({
      provider: 'openai',
      baseUrl: 'https://llm.example/v1/',
      apiKey: 'sk-test',
    }, fetchImpl as unknown as typeof fetch);

    expect(models).toEqual([
      { id: 'gpt-4.1' },
      { id: 'gpt-4.1-mini', displayName: 'GPT 4.1 mini' },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('discovers Anthropic models with x-api-key and version headers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }],
    }), { status: 200 }));

    const models = await discoverModels({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
    }, fetchImpl as unknown as typeof fetch);

    expect(models).toEqual([{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('rejects non-http endpoints and HTTP failures', async () => {
    await expect(discoverModels({
      provider: 'openai',
      baseUrl: 'file:///etc/passwd',
      apiKey: 'x',
    }, vi.fn() as unknown as typeof fetch)).rejects.toThrow('invalid_base_url');

    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(discoverModels({
      provider: 'openai',
      baseUrl: 'https://llm.example/v1',
      apiKey: 'bad',
    }, fetchImpl as unknown as typeof fetch)).rejects.toThrow('model_discovery_http_401');
  });
});
