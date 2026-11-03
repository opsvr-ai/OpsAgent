import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  RuntimeClient,
  RuntimeEvent,
  RuntimeSession,
  StartSessionInput,
} from '@opsagent/contracts';

export interface DshEventRunner {
  run(prompt: string, sessionId?: string): AsyncIterable<Record<string, unknown>>;
}

function toolRisk(tool: string): 'R0' | 'R1' | 'R2' {
  if (tool === 'read' || tool.endsWith('_read') || tool.endsWith('_query')) return 'R0';
  if (tool === 'search' || tool === 'list' || tool === 'glob') return 'R1';
  return 'R2';
}

export interface DshEventRunnerOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export class DshJsonRunner implements DshEventRunner {
  private readonly command: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(options: DshEventRunnerOptions = {}) {
    this.command = options.command ?? process.env.DSH_HEADLESS_COMMAND ?? 'dsh';
    this.cwd = options.cwd ?? process.env.OPSAGENT_WORKSPACE_ROOT ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async *run(prompt: string, sessionId?: string): AsyncIterable<Record<string, unknown>> {
    const args = ['headless', '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-');
    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${this.command} ${args.join(' ')}`], {
            cwd: this.cwd,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        : spawn(this.command, args, {
            cwd: this.cwd,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

    const timer = setTimeout(() => child.kill(), this.timeoutMs);
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    child.stdin.write(prompt);
    child.stdin.end();

    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Non-JSON diagnostic lines are ignored; stderr carries the error.
        }
      }
      const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
      if (code !== 0) throw new Error(`dsh_runtime_failed:${code}:${stderr.join('').slice(0, 500)}`);
    } finally {
      clearTimeout(timer);
      if (!child.killed) child.kill();
    }
  }
}

export class DshRuntime implements RuntimeClient {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly dshSessionIds = new Map<string, string>();

  constructor(private readonly runner: DshEventRunner = new DshJsonRunner()) {}

  async startSession(input: StartSessionInput): Promise<RuntimeSession> {
    const session: RuntimeSession = {
      runtimeSessionId: `dsh-${randomUUID()}`,
      tenantId: input.tenantId,
      userId: input.userId,
    };
    this.sessions.set(session.runtimeSessionId, session);
    return session;
  }

  async *prompt(sessionId: string, text: string, _idempotencyKey: string): AsyncIterable<RuntimeEvent> {
    if (!this.sessions.has(sessionId)) throw new Error(`unknown session: ${sessionId}`);
    let done = false;
    const toolNames = new Map<string, string>();
    for await (const event of this.runner.run(text, this.dshSessionIds.get(sessionId))) {
      if (event.type === 'session' && typeof event.sessionId === 'string') {
        this.dshSessionIds.set(sessionId, event.sessionId);
        continue;
      }
      if (event.type === 'text' && typeof event.text === 'string') {
        yield {
          type: 'assistant.delta',
          sessionId,
          at: new Date().toISOString(),
          text: event.text,
        };
        continue;
      }
      if (event.type === 'tool_call' && typeof event.tool === 'string') {
        const callId = typeof event.callId === 'string' ? event.callId : '';
        toolNames.set(callId, event.tool);
        yield {
          type: 'tool.call',
          sessionId,
          at: new Date().toISOString(),
          tool: event.tool,
          args:
            typeof event.input === 'object' && event.input !== null
              ? (event.input as Record<string, unknown>)
              : {},
          risk: toolRisk(event.tool),
        };
        continue;
      }
      if (event.type === 'tool_result') {
        const callId = typeof event.callId === 'string' ? event.callId : '';
        yield {
          type: 'tool.result',
          sessionId,
          at: new Date().toISOString(),
          tool: toolNames.get(callId) ?? 'unknown',
          result: event.result,
        };
        continue;
      }
      if (event.type === 'status' && event.phase === 'turn_end') {
        const reason = event.reason as { kind?: string; message?: string } | undefined;
        if (reason && reason.kind && reason.kind !== 'completed') {
          yield {
            type: 'runtime.error',
            sessionId,
            at: new Date().toISOString(),
            code: reason.kind,
            message: reason.message ?? 'dsh turn failed',
          };
        }
        if (!done) {
          done = true;
          yield { type: 'session.done', sessionId, at: new Date().toISOString() };
        }
        continue;
      }
      if (event.type === 'error') {
        yield {
          type: 'runtime.error',
          sessionId,
          at: new Date().toISOString(),
          code: typeof event.code === 'string' ? event.code : 'dsh_error',
          message: typeof event.message === 'string' ? event.message : 'dsh error',
        };
      }
    }
    if (!done) yield { type: 'session.done', sessionId, at: new Date().toISOString() };
  }

  async respondApproval(
    _sessionId: string,
    _approvalId: string,
    _decision: ApprovalDecision,
    _reason?: string,
  ): Promise<void> {
    throw new Error('dsh_runtime_approval_not_supported');
  }

  async resume(_sessionId: string): Promise<void> {}

  async close(): Promise<void> {
    this.sessions.clear();
    this.dshSessionIds.clear();
  }
}
