import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface HttpConnectorConfig {
  readonly baseUrl: string;
  readonly allowHosts: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function assertAllowed(baseUrl: string, allowHosts: readonly string[]): void {
  const host = new URL(baseUrl).hostname;
  if (!allowHosts.includes(host)) throw new Error(`host not allowed: ${host}`);
}

function makeTool(config: HttpConnectorConfig): ConnectorTool {
  assertAllowed(config.baseUrl, config.allowHosts);
  const fetchImpl = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const maxBytes = config.maxBytes ?? 1_048_576;

  return {
    name: 'http_get',
    risk: 'R1',
    async execute(input: Readonly<Record<string, unknown>>, context: ConnectorContext) {
      if (typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//')) {
        throw new Error('path must be relative and start with /');
      }

      const url = new URL(input.path, config.baseUrl);
      if (url.hostname !== new URL(config.baseUrl).hostname) {
        throw new Error('path must stay on the configured host');
      }
      if (input.query && typeof input.query === 'object' && !Array.isArray(input.query)) {
        for (const [key, value] of Object.entries(input.query)) {
          if (typeof value === 'string') url.searchParams.set(key, value);
        }
      }

      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: context.signal ?? AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json, text/plain;q=0.9' },
      });
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error('response_too_large');
      }
      const contentType = response.headers.get('content-type') ?? '';
      const body = contentType.includes('application/json') ? JSON.parse(text) : text;
      return { status: response.status, body };
    },
  };
}

export function createHttpConnector(config: HttpConnectorConfig): Connector {
  return {
    manifest: { id: 'http', name: 'Generic HTTP', version: '1.0.0' },
    tools: [makeTool(config)],
  };
}
