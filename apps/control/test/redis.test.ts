import { describe, expect, it, vi } from 'vitest';
import { createRedisConnector } from '../src/connectors/redis.js';

describe('redis connector', () => {
  it('reads INFO', async () => {
    const client = { info: vi.fn().mockResolvedValue('used_memory:1'), get: vi.fn(), scan: vi.fn() };
    const connector = createRedisConnector({ client });
    const result = await connector.tools[0]!.execute({ command: 'info' }, { tenantId: 't-1' });
    expect(result).toBe('used_memory:1');
    expect(client.info).toHaveBeenCalledOnce();
  });

  it('scans keys with a bounded count', async () => {
    const client = { info: vi.fn(), get: vi.fn(), scan: vi.fn().mockResolvedValue({ cursor: '0', keys: ['a'] }) };
    const connector = createRedisConnector({ client });
    const result = await connector.tools[0]!.execute(
      { command: 'scan', match: 'order:*', count: 1000 },
      { tenantId: 't-1' },
    );
    expect(result).toEqual({ cursor: '0', keys: ['a'] });
    expect(client.scan).toHaveBeenCalledWith('0', { MATCH: 'order:*', COUNT: 100 });
  });

  it('rejects arbitrary commands', async () => {
    const connector = createRedisConnector({ client: { info: vi.fn(), get: vi.fn(), scan: vi.fn() } });
    await expect(
      connector.tools[0]!.execute({ command: 'flushall' }, { tenantId: 't-1' }),
    ).rejects.toThrow('redis_command_not_allowed');
  });
});
