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

  it('rejects write and restart instructions', () => {
    expect(planInstruction('重启订单服务')).toMatchObject({ ok: false, error: 'unsupported_instruction' });
    expect(planInstruction('rm -rf /tmp/x')).toMatchObject({ ok: false, error: 'unsupported_instruction' });
    expect(planInstruction('')).toMatchObject({ ok: false, error: 'empty_instruction' });
  });
});
