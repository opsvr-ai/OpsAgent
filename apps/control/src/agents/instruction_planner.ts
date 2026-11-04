export type ServiceAction = 'service_restart' | 'service_stop';

export interface InstructionIntent {
  readonly kind: 'inspect' | ServiceAction;
  readonly params: {
    readonly question?: string;
    readonly service?: string;
  };
  readonly readOnly: boolean;
  readonly confidence: number;
  readonly risk?: 'R2';
}

export type InstructionPlan =
  | { readonly ok: true; readonly intent: InstructionIntent }
  | { readonly ok: false; readonly error: string; readonly reason: string };

const writeIntent = /(重启|停止|关闭|删除|安装|卸载|修改|写入|执行命令|运行命令|kill|restart|stop|rm\s|chmod|chown|systemctl\s+(restart|stop|disable))/i;
const restartIntent = /(?:重启|restart)\s*(?:服务\s*)?([a-z0-9][a-z0-9_.@-]{0,63})(?:\s*服务|\s*service)?/i;
const stopIntent = /(?:停止|stop)\s*(?:服务\s*)?([a-z0-9][a-z0-9_.@-]{0,63})(?:\s*服务|\s*service)?/i;
const forbiddenServices = new Set(['system', 'host', 'server', 'os', 'all', 'service', 'restart', 'stop']);
const protectedServices = new Set([
  'systemd', 'sshd', 'ssh', 'network', 'networking', 'dbus',
  'docker', 'containerd', 'kubelet', 'k3s',
  'agent', 'opsagent-agent', 'winrm', 'rpcss', 'lsass',
]);

/**
 * Planner for server-side natural language instructions.
 * Only read-only inspection and explicit, approval-gated service actions are supported.
 */
export function planInstruction(instruction: string): InstructionPlan {
  const question = instruction.trim();
  if (!question) return { ok: false, error: 'empty_instruction', reason: '指令为空' };
  if (question.length > 4000) return { ok: false, error: 'instruction_too_long', reason: '指令超过 4000 字' };

  const actionMatch = stopIntent.exec(question) ?? restartIntent.exec(question);
  if (actionMatch) {
    const service = actionMatch[1]?.toLowerCase() ?? '';
    if (!service || forbiddenServices.has(service)) {
      return {
        ok: false,
        error: 'unsupported_instruction',
        reason: '服务操作必须指定明确的服务名，例如：重启 nginx 服务',
      };
    }
    if (protectedServices.has(service)) {
      return {
        ok: false,
        error: 'unsupported_instruction',
        reason: `服务 ${service} 属于受保护服务，禁止通过自然语言操作`,
      };
    }
    const isStop = stopIntent.test(question);
    return {
      ok: true,
      intent: {
        kind: isStop ? 'service_stop' : 'service_restart',
        params: { service },
        readOnly: false,
        confidence: 0.85,
        risk: 'R2',
      },
    };
  }

  if (writeIntent.test(question)) {
    return {
      ok: false,
      error: 'unsupported_instruction',
      reason: '当前只支持只读检查和审批后的服务重启/停止，其他写操作暂不支持',
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
