import { describe, expect, it, vi } from 'vitest';
import { createPostgresConnector } from '../src/connectors/postgres.js';

describe('postgres connector', () => {
  it('runs a parameterized SELECT and returns rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
    const connector = createPostgresConnector({ query });

    const result = await connector.tools[0]!.execute(
      { sql: 'SELECT id FROM users WHERE id = $1', params: [1] },
      { tenantId: 't-1' },
    );

    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    expect(query).toHaveBeenCalledWith('SELECT id FROM users WHERE id = $1', [1]);
  });

  it('rejects non-read-only SQL', async () => {
    const connector = createPostgresConnector({ query: vi.fn() });
    await expect(
      connector.tools[0]!.execute({ sql: 'DELETE FROM users' }, { tenantId: 't-1' }),
    ).rejects.toThrow('read_only_query_required');
  });

  it('rejects multiple statements', async () => {
    const connector = createPostgresConnector({ query: vi.fn() });
    await expect(
      connector.tools[0]!.execute({ sql: 'SELECT 1; DROP TABLE users' }, { tenantId: 't-1' }),
    ).rejects.toThrow('single_statement_required');
  });
});
