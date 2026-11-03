import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface MysqlQueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

export type MysqlQueryFn = (
  sql: string,
  params: readonly unknown[],
) => Promise<MysqlQueryResult>;

export interface MysqlConfig {
  readonly query: MysqlQueryFn;
}

function assertReadOnly(sql: string): void {
  if (sql.includes(';')) throw new Error('single_statement_required');
  const normalized = sql.trimStart().toUpperCase();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    throw new Error('read_only_query_required');
  }
}

export function createMysqlConnector(config: MysqlConfig): Connector {
  const tool: ConnectorTool = {
    name: 'mysql_query',
    risk: 'R0',
    async execute(input: Readonly<Record<string, unknown>>, _context: ConnectorContext) {
      if (typeof input.sql !== 'string') throw new Error('sql_required');
      assertReadOnly(input.sql);
      const params = Array.isArray(input.params) ? input.params : [];
      const result = await config.query(input.sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
  return {
    manifest: { id: 'mysql', name: 'MySQL', version: '1.0.0' },
    tools: [tool],
  };
}
