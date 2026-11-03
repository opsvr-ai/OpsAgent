import { describe, expect, it, vi } from 'vitest';
import { createHttpConnector } from '../src/connectors/http.js';

describe('http connector', () => {
  it('performs an allowlisted GET and returns JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const connector = createHttpConnector({
      baseUrl: 'https://grafana.internal',
      allowHosts: ['grafana.internal'],
      fetch: fetchMock,
    });

    const result = await connector.tools[0]!.execute(
      { path: '/api/health' },
      { tenantId: 't-1' },
    );

    expect(result).toEqual({ status: 200, body: { status: 'ok' } });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://grafana.internal/api/health');
  });

  it('rejects a path that escapes the allowlisted host', async () => {
    const connector = createHttpConnector({
      baseUrl: 'https://grafana.internal',
      allowHosts: ['grafana.internal'],
      fetch: vi.fn(),
    });
    await expect(
      connector.tools[0]!.execute({ path: 'https://evil.example/x' }, { tenantId: 't-1' }),
    ).rejects.toThrow('path must be relative');
  });
});
