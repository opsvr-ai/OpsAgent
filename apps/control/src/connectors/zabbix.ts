import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface ZabbixConfig {
  readonly baseUrl: string;
  readonly allowHosts: readonly string[];
  readonly username: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface ZabbixResponse {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: string };
}

function assertAllowed(baseUrl: string, allowHosts: readonly string[]): void {
  const host = new URL(baseUrl).hostname;
  if (!allowHosts.includes(host)) throw new Error(`host not allowed: ${host}`);
}

async function call(
  config: ZabbixConfig,
  fetchImpl: typeof fetch,
  method: string,
  params: unknown,
  auth?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL('/api_jsonrpc.php', config.baseUrl);
  const id = 1;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(config.timeoutMs ?? 10_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id,
      ...(auth ? { auth } : {}),
    }),
  });
  if (!response.ok) throw new Error(`zabbix_http_${response.status}`);

  const body = (await response.json()) as ZabbixResponse;
  if (body.error) {
    if (method === 'user.login') throw new Error('zabbix_auth_failed');
    throw new Error(`zabbix_api_error: ${body.error.message}`);
  }
  return body.result;
}

function makeTool(config: ZabbixConfig): ConnectorTool {
  assertAllowed(config.baseUrl, config.allowHosts);
  const fetchImpl = config.fetch ?? fetch;

  return {
    name: 'zabbix_hosts',
    risk: 'R0',
    async execute(input: Readonly<Record<string, unknown>>, context: ConnectorContext) {
      const token = await call(
        config,
        fetchImpl,
        'user.login',
        { username: config.username, password: config.password },
        undefined,
        context.signal,
      );
      if (typeof token !== 'string') throw new Error('zabbix_auth_failed');

      const params: Record<string, unknown> = {
        output: ['hostid', 'host'],
        limit: 100,
      };
      if (typeof input.search === 'string' && input.search.trim() !== '') {
        params.search = { host: input.search };
      }
      return call(config, fetchImpl, 'host.get', params, token, context.signal);
    },
  };
}

export function createZabbixConnector(config: ZabbixConfig): Connector {
  return {
    manifest: { id: 'zabbix', name: 'Zabbix', version: '1.0.0' },
    tools: [makeTool(config)],
  };
}
