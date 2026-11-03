import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface AlertmanagerConfig {
  readonly baseUrl: string;
  readonly allowHosts: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function assertAllowed(baseUrl: string, allowHosts: readonly string[]): void {
  const host = new URL(baseUrl).hostname;
  if (!allowHosts.includes(host)) throw new Error(`host not allowed: ${host}`);
}

export function createAlertmanagerConnector(config: AlertmanagerConfig): Connector {
  assertAllowed(config.baseUrl, config.allowHosts);
  const fetchImpl = config.fetch ?? fetch;
  const tool: ConnectorTool = {
    name: 'alertmanager_alerts',
    risk: 'R0',
    async execute(_input: Readonly<Record<string, unknown>>, context: ConnectorContext) {
      const url = new URL('/api/v2/alerts', config.baseUrl);
      url.searchParams.set('active', 'true');
      url.searchParams.set('silenced', 'false');
      url.searchParams.set('inhibited', 'false');
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: context.signal ?? AbortSignal.timeout(config.timeoutMs ?? 10_000),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`alertmanager_http_${response.status}`);
      return response.json();
    },
  };

  return {
    manifest: { id: 'alertmanager', name: 'Alertmanager', version: '1.0.0' },
    tools: [tool],
  };
}
