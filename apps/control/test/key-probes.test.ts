import { describe, expect, it, vi } from 'vitest';
import { createClickHouseProbe, createZabbixProbe } from '../src/connectors/http-probes.js';
import type { ConnectorRecord } from '../src/connectors/service.js';

function record(type: string, config: Record<string, unknown>): ConnectorRecord {
  return {
    id: 'c-1',
    tenantId: 't-1',
    connectorType: type,
    name: type,
    config,
    credentialRef: null,
    status: 'draft',
  };
}

describe('ClickHouse/Zabbix probes', () => {
  it('probes ClickHouse with SELECT 1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('1\n', { status: 200 }));
    const probe = createClickHouseProbe({ fetch: fetchMock });
    const result = await probe.probe(
      record('clickhouse', { baseUrl: 'http://clickhouse.internal:8123', database: 'ops' }),
    );
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('SELECT');
  });

  it('probes Zabbix API version without credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', result: '7.0', id: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const probe = createZabbixProbe({ fetch: fetchMock });
    const result = await probe.probe(record('zabbix', { baseUrl: 'http://zabbix.internal' }));
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('apiinfo.version');
  });
});
