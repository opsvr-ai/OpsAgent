import { describe, expect, it, vi } from 'vitest';
import { createSshConnector } from '../src/connectors/ssh.js';

describe('ssh connector', () => {
  it('executes a fixed read-only check', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'up 3 days', stderr: '', code: 0 });
    const connector = createSshConnector({ exec });
    const result = await connector.tools[0]!.execute({ check: 'uptime' }, { tenantId: 't-1' });
    expect(result).toMatchObject({ stdout: 'up 3 days' });
    expect(exec).toHaveBeenCalledWith('uptime');
  });

  it('rejects free-form commands', async () => {
    const connector = createSshConnector({ exec: vi.fn() });
    await expect(
      connector.tools[0]!.execute({ check: 'rm -rf /' }, { tenantId: 't-1' }),
    ).rejects.toThrow('ssh_check_not_allowed');
  });
});
