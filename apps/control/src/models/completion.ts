import type { ModelProviderService } from './service.js';

export interface CompletionRequest {
  readonly tenantId: string;
  readonly modelId?: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens?: number;
  /** 请求超时（毫秒），默认 45s；拓扑分析等长任务可显式放宽。 */
  readonly timeoutMs?: number;
  /** 要求 OpenAI 兼容网关返回 JSON object（不支持时自动按 400 重试）。 */
  readonly json?: boolean;
}

function openAiBase(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/v\d+$/i.test(base) ? base : `${base}/v1`;
}

function anthropicBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function clampTimeout(value: number | undefined): number {
  const raw = Number.isFinite(value) ? Number(value) : 45_000;
  return Math.min(Math.max(raw, 1_000), 300_000);
}

async function readJson(response: Response): Promise<{
  body: Record<string, unknown>;
  raw: string;
}> {
  const raw = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as unknown;
    return {
      body: typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {},
      raw,
    };
  } catch {
    return { body: {}, raw };
  }
}

function errorMessage(body: Record<string, unknown>, raw: string): string {
  const error = body.error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.slice(0, 300);
  }
  if (typeof error === 'string' && error.trim()) return error.slice(0, 300);
  return raw.trim().slice(0, 300) || 'unknown model error';
}

function networkError(error: unknown): Error {
  const cause = error && typeof error === 'object' && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause
    ? String((cause as { code?: unknown }).code)
    : '';
  const message = error instanceof Error ? error.message : 'fetch failed';
  if (/timeout|aborted/i.test(message) || code === 'ETIMEDOUT') {
    return new Error(`model_timeout:${message.slice(0, 160)}`);
  }
  return new Error(`model_fetch_failed:${code || message.slice(0, 200)}`);
}

async function postJson(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw networkError(error);
  }
}

export interface ModelDescription {
  /** 实际请求的模型名（model 字段）。 */
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
}

export class ModelCompletionService {
  constructor(private readonly models: ModelProviderService) {}

  /**
   * 解析当前租户的默认（或指定）模型，供分析 trace / 排障展示。
   * 不返回 apiKey 等敏感信息；未配置模型时返回 null。
   */
  async describe(tenantId: string, modelId?: string): Promise<ModelDescription | null> {
    const model = await this.models.resolve(tenantId, modelId);
    if (!model) return null;
    return {
      name: model.model,
      provider: model.provider,
      baseUrl: model.baseUrl,
    };
  }

  async complete(input: CompletionRequest): Promise<string> {
    const model = await this.models.resolve(input.tenantId, input.modelId);
    if (!model) throw new Error('model_not_configured');
    const maxTokens = Math.min(Math.max(input.maxTokens ?? 1200, 128), 4096);
    const timeout = AbortSignal.timeout(clampTimeout(input.timeoutMs));

    if (model.provider.toLowerCase() === 'anthropic') {
      const response = await postJson(`${anthropicBase(model.baseUrl)}/v1/messages`, {
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
      const { body, raw } = await readJson(response);
      if (!response.ok) throw new Error(`model_http_${response.status}:${errorMessage(body, raw)}`);
      const content = Array.isArray(body.content)
        ? (body.content as Array<{ type?: unknown; text?: unknown }>)
        : [];
      const text = content
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('');
      if (!text) throw new Error('model_empty_response');
      return text;
    }

    const messages = [
      { role: 'system', content: input.system },
      { role: 'user', content: input.prompt },
    ];
    const url = `${openAiBase(model.baseUrl)}/chat/completions`;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${model.apiKey}`,
    };
    let response = await postJson(url, {
      method: 'POST',
      headers,
      // stream:false 显式声明，兼容默认开启流式的内网网关。
      body: JSON.stringify({
        model: model.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages,
        stream: false,
        ...(input.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: timeout,
    });
    let parsed = await readJson(response);
    // 部分内网网关不接受 temperature/max_tokens/stream 等可选参数（400/422），
    // 用最小 payload 重试一次，尽量兼容。
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      const retry = await postJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: model.model, messages }),
        signal: timeout,
      });
      const retryParsed = await readJson(retry);
      if (retry.ok) {
        response = retry;
        parsed = retryParsed;
      } else {
        throw new Error(
          `model_http_${response.status}:${errorMessage(parsed.body, parsed.raw)}`
          + ` / retry_${retry.status}:${errorMessage(retryParsed.body, retryParsed.raw)}`,
        );
      }
    }
    const { body, raw } = parsed;
    if (!response.ok) throw new Error(`model_http_${response.status}:${errorMessage(body, raw)}`);
    const choices = Array.isArray(body.choices)
      ? (body.choices as Array<Record<string, unknown>>)
      : [];
    const first = choices[0];
    const message = first && typeof first.message === 'object' && first.message !== null
      ? first.message as Record<string, unknown>
      : {};
    // 兼容：标准 content；部分推理模型只给 reasoning_content；部分网关用 text。
    const candidates = [
      message.content,
      message.reasoning_content,
      first?.text,
      typeof body.output_text === 'string' ? body.output_text : undefined,
    ];
    const text = candidates.find((value): value is string => typeof value === 'string' && value.trim() !== '');
    if (!text) {
      const finish = typeof first?.finish_reason === 'string' ? first.finish_reason : '';
      throw new Error(
        `model_empty_response${finish ? `:${finish}` : ''}:${raw.trim().slice(0, 200)}`,
      );
    }
    return text;
  }
}
