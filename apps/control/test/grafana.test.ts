import { describe, expect, it, vi } from 'vitest';
import { createGrafanaConnector } from '../src/connectors/grafana.js';

describe('grafana connector', () => {
  it('reads health and datasources from allowlisted Grafana', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ database: 'ok', version: '11.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ uid: 'prom-1', type: 'prometheus' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const connector = createGrafanaConnector({
      baseUrl: 'https://grafana.internal',
      allowHosts: ['grafana.internal'],
      fetch: fetchMock,
    });

    const health = await connector.tools[0]!.execute({}, { tenantId: 't-1' });
    expect(health).toMatchObject({ database: 'ok' });
    const datasources = await connector.tools[1]!.execute({}, { tenantId: 't-1' });
    expect(datasources).toEqual([{ uid: 'prom-1', type: 'prometheus' }]);
  });

  it('rejects a non-allowlisted host', () => {
    expect(() =>
      createGrafanaConnector({
        baseUrl: 'https://evil.example',
        allowHosts: ['grafana.internal'],
        fetch: vi.fn(),
      }),
    ).toThrow('host not allowed');
  });
});
