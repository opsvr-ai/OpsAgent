export type ServiceAction = 'service_restart' | 'service_stop' | 'service_start' | 'service_enable' | 'service_disable';

export interface InstructionIntent {
  readonly kind: 'inspect' | 'service_status' | ServiceAction;
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

const writeIntent = /(重启|停止|启动|启用|禁用|关闭|删除|安装|卸载|修改|写入|执行命令|运行命令|kill|restart|stop|start|enable|disable|rm\s|chmod|chown|systemctl\s+(restart|stop|start|enable|disable))/i;
const serviceActionIntent = /(重启|停止|启动|启用|禁用|restart|stop|start|enable|disable)\s*(?:服务\s*)?([a-z0-9][a-z0-9_.@-]{0,63})(?:\s*服务|\s*service)?/i;
const serviceStatusIntent = /(?:查看|检查|查询|看看)?\s*(?:服务\s*)?([a-z0-9][a-z0-9_.@-]{0,63})\s*(?:服务)?\s*(?:状态|status)/i;
const forbiddenServices = new Set(['system', 'host', 'server', 'os', 'all', 'service', 'restart', 'stop', 'start', 'enable', 'disable']);
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

  const actionMatch = serviceActionIntent.exec(question);
  if (actionMatch) {
    const verb = (actionMatch[1] ?? '').toLowerCase();
    const service = (actionMatch[2] ?? '').toLowerCase();
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
    const kind: ServiceAction = verb === '停止' || verb === 'stop'
      ? 'service_stop'
      : verb === '启动' || verb === 'start'
        ? 'service_start'
        : verb === '启用' || verb === 'enable'
          ? 'service_enable'
          : verb === '禁用' || verb === 'disable' ? 'service_disable' : 'service_restart';
    return {
      ok: true,
      intent: {
        kind,
        params: { service },
        readOnly: false,
        confidence: 0.85,
        risk: 'R2',
      },
    };
  }

  const statusMatch = serviceStatusIntent.exec(question);
  if (statusMatch) {
    const service = (statusMatch[1] ?? '').toLowerCase();
    if (service && !forbiddenServices.has(service)) {
      return {
        ok: true,
        intent: {
          kind: 'service_status',
          params: { service },
          readOnly: true,
          confidence: 0.8,
        },
      };
    }
  }

  if (writeIntent.test(question)) {
    return {
      ok: false,
      error: 'unsupported_instruction',
      reason: '当前只支持只读检查和审批后的服务启动/停止/重启/启用/禁用，其他写操作暂不支持',
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
