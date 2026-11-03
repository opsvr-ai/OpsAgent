import { describe, expect, it, vi } from 'vitest';
import { createMysqlConnector } from '../src/connectors/mysql.js';

describe('mysql connector', () => {
  it('runs a read-only query with params', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
    const connector = createMysqlConnector({ query });
    const result = await connector.tools[0]!.execute(
      { sql: 'SELECT id FROM users WHERE id = ?', params: [1] },
      { tenantId: 't-1' },
    );
    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    expect(query).toHaveBeenCalledWith('SELECT id FROM users WHERE id = ?', [1]);
  });

  it('rejects writes', async () => {
    const connector = createMysqlConnector({ query: vi.fn() });
    await expect(
      connector.tools[0]!.execute({ sql: 'UPDATE users SET x=1' }, { tenantId: 't-1' }),
    ).rejects.toThrow('read_only_query_required');
  });
});
