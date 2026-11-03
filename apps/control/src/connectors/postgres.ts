import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface QueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

export type QueryFn = (sql: string, params: readonly unknown[]) => Promise<QueryResult>;

export interface PostgresConnectorConfig {
  readonly query: QueryFn;
}

function readOnly(sql: string): void {
  if (sql.includes(';')) throw new Error('single_statement_required');
  const normalized = sql.trimStart().toUpperCase();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    throw new Error('read_only_query_required');
  }
}

function makeTool(config: PostgresConnectorConfig): ConnectorTool {
  return {
    name: 'postgres_query',
    risk: 'R0',
    async execute(input: Readonly<Record<string, unknown>>, _context: ConnectorContext) {
      if (typeof input.sql !== 'string') throw new Error('sql_required');
      readOnly(input.sql);
      const params = Array.isArray(input.params) ? input.params : [];
      const result = await config.query(input.sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export function createPostgresConnector(config: PostgresConnectorConfig): Connector {
  return {
    manifest: { id: 'postgres', name: 'PostgreSQL', version: '1.0.0' },
    tools: [makeTool(config)],
  };
}
