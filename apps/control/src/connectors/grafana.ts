import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface GrafanaConfig {
  readonly baseUrl: string;
  readonly allowHosts: readonly string[];
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function assertAllowed(baseUrl: string, allowHosts: readonly string[]): void {
  const host = new URL(baseUrl).hostname;
  if (!allowHosts.includes(host)) throw new Error(`host not allowed: ${host}`);
}

function makeTool(
  config: GrafanaConfig,
  name: 'grafana_health' | 'grafana_datasources',
  path: string,
): ConnectorTool {
  const fetchImpl = config.fetch ?? fetch;
  return {
    name,
    risk: 'R0',
    async execute(_input: Readonly<Record<string, unknown>>, context: ConnectorContext) {
      const response = await fetchImpl(new URL(path, config.baseUrl), {
        method: 'GET',
        redirect: 'error',
        signal: context.signal ?? AbortSignal.timeout(config.timeoutMs ?? 10_000),
        headers: {
          accept: 'application/json',
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        },
      });
      if (!response.ok) throw new Error(`grafana_http_${response.status}`);
      return response.json();
    },
  };
}

export function createGrafanaConnector(config: GrafanaConfig): Connector {
  assertAllowed(config.baseUrl, config.allowHosts);
  return {
    manifest: { id: 'grafana', name: 'Grafana', version: '1.0.0' },
    tools: [
      makeTool(config, 'grafana_health', '/api/health'),
      makeTool(config, 'grafana_datasources', '/api/datasources'),
    ],
  };
}
