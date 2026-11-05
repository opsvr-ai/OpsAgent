import type { ModelProviderService } from './service.js';

export interface CompletionRequest {
  readonly tenantId: string;
  readonly modelId?: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens?: number;
}

function openAiBase(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/v\d+$/i.test(base) ? base : `${base}/v1`;
}

function anthropicBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export class ModelCompletionService {
  constructor(private readonly models: ModelProviderService) {}

  async complete(input: CompletionRequest): Promise<string> {
    const model = await this.models.resolve(input.tenantId, input.modelId);
    if (!model) throw new Error('model_not_configured');
    const maxTokens = Math.min(Math.max(input.maxTokens ?? 1200, 128), 4096);
    const timeout = AbortSignal.timeout(45_000);

    if (model.provider.toLowerCase() === 'anthropic') {
      const response = await fetch(`${anthropicBase(model.baseUrl)}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': model.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model.model,
          max_tokens: maxTokens,
          system: input.system,
          messages: [{ role: 'user', content: input.prompt }],
        }),
        signal: timeout,
      });
      const body = (await response.json().catch(() => ({}))) as {
        content?: Array<{ type?: string; text?: string }>;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(`model_http_${response.status}:${body.error?.message ?? ''}`);
      const text = (body.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      if (!text) throw new Error('model_empty_response');
      return text;
    }

    const response = await fetch(`${openAiBase(model.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.prompt },
        ],
      }),
      signal: timeout,
    });
    const body = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(`model_http_${response.status}:${body.error?.message ?? ''}`);
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error('model_empty_response');
    return text;
  }
}
