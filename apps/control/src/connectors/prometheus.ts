import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface PrometheusConfig {
  readonly baseUrl: string;
  readonly allowHosts: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface PrometheusResponse {
  readonly status: 'success' | 'error';
  readonly data?: {
    readonly resultType: string;
    readonly result: unknown;
  };
  readonly error?: string;
}

function assertAllowed(baseUrl: string, allowHosts: readonly string[]): void {
  const url = new URL(baseUrl);
  if (!allowHosts.includes(url.hostname)) {
    throw new Error(`host not allowed: ${url.hostname}`);
  }
}

function makeTool(config: PrometheusConfig): ConnectorTool {
  assertAllowed(config.baseUrl, config.allowHosts);
  const fetchImpl = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  return {
    name: 'prometheus_query',
    risk: 'R0',
    async execute(input: Readonly<Record<string, unknown>>, context: ConnectorContext) {
      if (typeof input.query !== 'string' || input.query.trim() === '') {
        throw new Error('prometheus_query requires a non-empty query');
      }

      const url = new URL('/api/v1/query', config.baseUrl);
      url.searchParams.set('query', input.query);
      const signal = context.signal ?? AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        throw new Error(`prometheus_http_${response.status}`);
      }

      const body = (await response.json()) as PrometheusResponse;
      if (body.status !== 'success' || !body.data) {
        throw new Error(body.error ?? 'prometheus_query_failed');
      }
      return body.data;
    },
  };
}

export function createPrometheusConnector(config: PrometheusConfig): Connector {
  return {
    manifest: {
      id: 'prometheus',
      name: 'Prometheus',
      version: '1.0.0',
    },
    tools: [makeTool(config)],
  };
}
