import { describe, expect, it, vi } from 'vitest';
import { createClickHouseConnector } from '../src/connectors/clickhouse.js';

describe('clickhouse connector', () => {
  it('runs a read-only query and returns JSON rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ count: 3 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const connector = createClickHouseConnector({
      baseUrl: 'http://clickhouse.internal:8123',
      allowHosts: ['clickhouse.internal'],
      database: 'ops',
      fetch: fetchMock,
    });

    const result = await connector.tools[0]!.execute(
      { sql: 'SELECT count() AS count FROM events' },
      { tenantId: 't-1' },
    );

    expect(result).toEqual([{ count: 3 }]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('database=ops');
    expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain('FORMAT JSON');
  });

  it('rejects non-read-only SQL', async () => {
    const connector = createClickHouseConnector({
      baseUrl: 'http://clickhouse.internal:8123',
      allowHosts: ['clickhouse.internal'],
      database: 'ops',
      fetch: vi.fn(),
    });
    await expect(
      connector.tools[0]!.execute({ sql: 'DROP TABLE events' }, { tenantId: 't-1' }),
    ).rejects.toThrow('read_only_query_required');
  });
});
