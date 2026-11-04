import { describe, expect, it } from 'vitest';
import { deriveRootCause, type AppHealthFinding } from '../src/agents/health.js';

function finding(
  agentId: string,
  hostname: string,
  issues: string[],
  status: AppHealthFinding['status'] = 'warning',
): AppHealthFinding {
  return {
    agentId, hostname, status, issues,
    metrics: {}, applications: [], events: [], logSignals: [],
  };
}

describe('agent health root cause', () => {
  it('prefers a shared issue across nodes', () => {
    const cause = deriveRootCause([
      finding('a', 'web-1', ['数据库连接超时']),
      finding('b', 'web-2', ['数据库连接超时']),
    ], 'a');
    expect(cause).toContain('多节点共同异常');
    expect(cause).toContain('数据库连接超时');
    expect(cause).toContain('web-1');
    expect(cause).toContain('web-2');
  });

  it('reports an offline trigger node first', () => {
    const cause = deriveRootCause([
      finding('a', 'web-1', ['节点离线，最近心跳异常'], 'offline'),
      finding('b', 'web-2', [], 'healthy'),
    ], 'a');
    expect(cause).toContain('web-1');
    expect(cause).toContain('离线');
  });
});
