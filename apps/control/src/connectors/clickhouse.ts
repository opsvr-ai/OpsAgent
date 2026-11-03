import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface ClickHouseConfig {
  readonly baseUrl: string;
  readonly allowHosts: readonly string[];
  readonly database: string;
  readonly username?: string;
  readonly password?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function assertAllowed(baseUrl: string, allowHosts: readonly string[]): void {
  const host = new URL(baseUrl).hostname;
  if (!allowHosts.includes(host)) throw new Error(`host not allowed: ${host}`);
}

function assertReadOnly(sql: string): void {
  if (sql.includes(';')) throw new Error('single_statement_required');
  const normalized = sql.trimStart().toUpperCase();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    throw new Error('read_only_query_required');
  }
}

export function createClickHouseConnector(config: ClickHouseConfig): Connector {
  assertAllowed(config.baseUrl, config.allowHosts);
  const fetchImpl = config.fetch ?? fetch;
  const tool: ConnectorTool = {
    name: 'clickhouse_query',
    risk: 'R0',
    async execute(input: Readonly<Record<string, unknown>>, context: ConnectorContext) {
      if (typeof input.sql !== 'string') throw new Error('sql_required');
      assertReadOnly(input.sql);

      const query = `${input.sql} FORMAT JSON`;
      const url = new URL('/', config.baseUrl);
      url.searchParams.set('database', config.database);
      url.searchParams.set('query', query);
      const auth = config.username
        ? `Basic ${Buffer.from(`${config.username}:${config.password ?? ''}`).toString('base64')}`
        : undefined;
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        signal: context.signal ?? AbortSignal.timeout(config.timeoutMs ?? 15_000),
        headers: {
          accept: 'application/json',
          'content-type': 'text/plain',
          ...(auth ? { authorization: auth } : {}),
        },
        body: query,
      });
      if (!response.ok) throw new Error(`clickhouse_http_${response.status}`);
      const body = (await response.json()) as { data?: unknown[] };
      return body.data ?? [];
    },
  };

  return {
    manifest: { id: 'clickhouse', name: 'ClickHouse', version: '1.0.0' },
    tools: [tool],
  };
}
