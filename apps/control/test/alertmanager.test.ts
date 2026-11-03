import { describe, expect, it, vi } from 'vitest';
import { createAlertmanagerConnector } from '../src/connectors/alertmanager.js';

describe('alertmanager connector', () => {
  it('reads active alerts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ fingerprint: 'a1', status: { state: 'active' } }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const connector = createAlertmanagerConnector({
      baseUrl: 'http://alertmanager.internal:9093',
      allowHosts: ['alertmanager.internal'],
      fetch: fetchMock,
    });

    const result = await connector.tools[0]!.execute({}, { tenantId: 't-1' });
    expect(result).toEqual([{ fingerprint: 'a1', status: { state: 'active' } }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v2/alerts');
  });

  it('surfaces upstream errors', async () => {
    const connector = createAlertmanagerConnector({
      baseUrl: 'http://alertmanager.internal:9093',
      allowHosts: ['alertmanager.internal'],
      fetch: vi.fn().mockResolvedValue(new Response('down', { status: 503 })),
    });
    await expect(connector.tools[0]!.execute({}, { tenantId: 't-1' })).rejects.toThrow(
      'alertmanager_http_503',
    );
  });
});
