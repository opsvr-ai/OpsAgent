export interface InstructionIntent {
  readonly kind: 'inspect';
  readonly params: { readonly question: string };
  readonly readOnly: true;
  readonly confidence: number;
}

export type InstructionPlan =
  | { readonly ok: true; readonly intent: InstructionIntent }
  | { readonly ok: false; readonly error: string; readonly reason: string };

const writeIntent = /(重启|停止|关闭|删除|安装|卸载|修改|写入|执行命令|运行命令|kill|restart|stop|rm\s|chmod|chown|systemctl\s+(restart|stop|disable))/i;

/**
 * Phase 1 planner: only read-only host inspection is allowed.
 * Natural language is never translated into a shell command.
 */
export function planInstruction(instruction: string): InstructionPlan {
  const question = instruction.trim();
  if (!question) return { ok: false, error: 'empty_instruction', reason: '指令为空' };
  if (question.length > 4000) return { ok: false, error: 'instruction_too_long', reason: '指令超过 4000 字' };
  if (writeIntent.test(question)) {
    return {
      ok: false,
      error: 'unsupported_instruction',
      reason: '首版只允许只读检查，修改/重启/删除类指令需要审批流程',
    };
  }
  return {
    ok: true,
    intent: {
      kind: 'inspect',
      params: { question },
      readOnly: true,
      confidence: 0.9,
    },
  };
}
