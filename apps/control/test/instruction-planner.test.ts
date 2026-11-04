import { describe, expect, it } from 'vitest';
import { planInstruction } from '../src/agents/instruction_planner.js';

describe('agent instruction planner', () => {
  it('plans read-only inspection', () => {
    const plan = planInstruction('系统运行多久了');
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.intent.kind).toBe('inspect');
      expect(plan.intent.readOnly).toBe(true);
      expect(plan.intent.params.question).toBe('系统运行多久了');
    }
  });

  it('plans an approval-gated service restart', () => {
    expect(planInstruction('重启 nginx 服务')).toMatchObject({
      ok: true,
      intent: { kind: 'service_restart', params: { service: 'nginx' }, readOnly: false, risk: 'R2' },
    });
    expect(planInstruction('重启服务 redis')).toMatchObject({
      ok: true,
      intent: { kind: 'service_restart', params: { service: 'redis' } },
    });
    expect(planInstruction('停止 nginx 服务')).toMatchObject({
      ok: true,
      intent: { kind: 'service_stop', params: { service: 'nginx' }, readOnly: false, risk: 'R2' },
    });
    expect(planInstruction('启动 nginx 服务')).toMatchObject({
      ok: true,
      intent: { kind: 'service_start', params: { service: 'nginx' }, readOnly: false, risk: 'R2' },
    });
    expect(planInstruction('启用 nginx 服务')).toMatchObject({
      ok: true,
      intent: { kind: 'service_enable', params: { service: 'nginx' } },
    });
    expect(planInstruction('禁用 nginx 服务')).toMatchObject({
      ok: true,
      intent: { kind: 'service_disable', params: { service: 'nginx' } },
    });
  });

  it('rejects unsupported write instructions', () => {
    expect(planInstruction('重启订单服务')).toMatchObject({ ok: false, error: 'unsupported_instruction' });
    expect(planInstruction('rm -rf /tmp/x')).toMatchObject({ ok: false, error: 'unsupported_instruction' });
    expect(planInstruction('重启系统')).toMatchObject({ ok: false, error: 'unsupported_instruction' });
    expect(planInstruction('重启 sshd 服务')).toMatchObject({ ok: false, error: 'unsupported_instruction' });
    expect(planInstruction('')).toMatchObject({ ok: false, error: 'empty_instruction' });
  });
});
