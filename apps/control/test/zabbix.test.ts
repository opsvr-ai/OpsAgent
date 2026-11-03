import { describe, expect, it, vi } from 'vitest';
import { createZabbixConnector } from '../src/connectors/zabbix.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('zabbix connector', () => {
  it('logs in with the API user and queries hosts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', result: 'token-1', id: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          result: [{ hostid: '10084', host: 'db-01' }],
          id: 2,
        }),
      );
    const connector = createZabbixConnector({
      baseUrl: 'http://zabbix.internal',
      allowHosts: ['zabbix.internal'],
      username: 'opsagent',
      password: 'secret',
      fetch: fetchMock,
    });

    const result = await connector.tools[0]!.execute(
      { search: 'db' },
      { tenantId: 't-1' },
    );

    expect(result).toEqual([{ hostid: '10084', host: 'db-01' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstBody.method).toBe('user.login');
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.method).toBe('host.get');
    expect(secondBody.auth).toBe('token-1');
  });

  it('fails closed when Zabbix rejects login', async () => {
    const connector = createZabbixConnector({
      baseUrl: 'http://zabbix.internal',
      allowHosts: ['zabbix.internal'],
      username: 'opsagent',
      password: 'wrong',
      fetch: vi.fn().mockResolvedValue(
        jsonResponse({ jsonrpc: '2.0', error: { code: -32602, message: 'bad login' }, id: 1 }),
      ),
    });
    await expect(
      connector.tools[0]!.execute({}, { tenantId: 't-1' }),
    ).rejects.toThrow('zabbix_auth_failed');
  });
});
