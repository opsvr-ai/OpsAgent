import { describe, expect, it, vi } from 'vitest';
import {
  createAlertmanagerProbe,
  createGrafanaProbe,
  createPrometheusProbe,
} from '../src/connectors/http-probes.js';
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

describe('HTTP connector probes', () => {
  it('probes Prometheus with vector(1)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const probe = createPrometheusProbe({ fetch: fetchMock });
    const result = await probe.probe(
      record('prometheus', { baseUrl: 'http://prometheus.internal:9090' }),
    );
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/query');
  });

  it('reports failure when Grafana is unhealthy', async () => {
    const probe = createGrafanaProbe({
      fetch: vi.fn().mockResolvedValue(new Response('down', { status: 503 })),
    });
    const result = await probe.probe(record('grafana', { baseUrl: 'http://grafana.internal' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
  });

  it('probes Alertmanager status', async () => {
    const probe = createAlertmanagerProbe({
      fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    });
    const result = await probe.probe(
      record('alertmanager', { baseUrl: 'http://alertmanager.internal:9093' }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a missing baseUrl', async () => {
    const probe = createPrometheusProbe({ fetch: vi.fn() });
    const result = await probe.probe(record('prometheus', {}));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('baseUrl');
  });
});
