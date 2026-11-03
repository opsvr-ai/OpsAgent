import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface SshExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type SshExec = (command: string) => Promise<SshExecResult>;

export interface SshConfig {
  readonly exec: SshExec;
}

const CHECKS = {
  uptime: 'uptime',
  disk: 'df -P',
  memory: 'free -m',
  load: 'cat /proc/loadavg',
} as const;

type SshCheck = keyof typeof CHECKS;

function isCheck(value: unknown): value is SshCheck {
  return typeof value === 'string' && value in CHECKS;
}

export function createSshConnector(config: SshConfig): Connector {
  const tool: ConnectorTool = {
    name: 'ssh_read',
    risk: 'R0',
    async execute(input: Readonly<Record<string, unknown>>, _context: ConnectorContext) {
      if (!isCheck(input.check)) throw new Error('ssh_check_not_allowed');
      return config.exec(CHECKS[input.check]);
    },
  };
  return {
    manifest: { id: 'ssh', name: 'SSH', version: '1.0.0' },
    tools: [tool],
  };
}
