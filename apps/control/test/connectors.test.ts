import { describe, expect, it, vi } from 'vitest';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { createPrometheusConnector } from '../src/connectors/prometheus.js';
import type { Connector } from '../src/connectors/types.js';

function connector(id: string): Connector {
  return {
    manifest: { id, name: id, version: '1.0.0' },
    tools: [
      {
        name: `${id}_ping`,
        risk: 'R0',
        async execute() {
          return { ok: true };
        },
      },
    ],
  };
}

describe('connector registry', () => {
  it('registers and retrieves connectors', () => {
    const registry = new ConnectorRegistry();
    registry.register(connector('prometheus'));
    expect(registry.get('prometheus')?.manifest.name).toBe('prometheus');
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects duplicate connector ids', () => {
    const registry = new ConnectorRegistry();
    registry.register(connector('prometheus'));
    expect(() => registry.register(connector('prometheus'))).toThrow('connector already registered');
  });
});

describe('prometheus connector', () => {
  it('queries the Prometheus HTTP API and returns data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: { resultType: 'vector', result: [{ metric: { instance: 'a' }, value: [1, '1'] }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const prometheus = createPrometheusConnector({
      baseUrl: 'http://prometheus.internal:9090',
      allowHosts: ['prometheus.internal'],
      fetch: fetchMock,
    });
    const result = await prometheus.tools[0]!.execute(
      { query: 'up{job="api"}' },
      { tenantId: 't-1' },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/v1/query?');
    expect(url).toContain('query=up%7Bjob%3D%22api%22%7D');
    expect(result).toMatchObject({ resultType: 'vector' });
  });

  it('fails closed for a non-allowlisted host at configuration time', () => {
    expect(() =>
      createPrometheusConnector({
        baseUrl: 'http://evil.example:9090',
        allowHosts: ['prometheus.internal'],
        fetch: vi.fn(),
      }),
    ).toThrow('host not allowed');
  });

  it('surfaces upstream errors', async () => {
    const prometheus = createPrometheusConnector({
      baseUrl: 'http://prometheus.internal:9090',
      allowHosts: ['prometheus.internal'],
      fetch: vi.fn().mockResolvedValue(new Response('nope', { status: 502 })),
    });
    await expect(
      prometheus.tools[0]!.execute({ query: 'up' }, { tenantId: 't-1' }),
    ).rejects.toThrow('prometheus_http_502');
  });
});
