import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ApprovalDecision,
  PermissionMode,
  PromptOptions,
  RuntimeClient,
  RuntimeEvent,
  RuntimeSession,
  StartSessionInput,
} from '@opsagent/contracts';

export interface DshEventRunner {
  run(
    prompt: string,
    sessionId?: string,
    env?: Readonly<Record<string, string>>,
  ): AsyncIterable<Record<string, unknown>>;
}

export interface DshModelProvider {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

export type DshModelResolver = (tenantId: string, modelId?: string) => Promise<DshModelProvider | null>;

function toolRisk(tool: string): 'R0' | 'R1' | 'R2' {
  if (tool === 'read' || tool.endsWith('_read') || tool.endsWith('_query')) return 'R0';
  if (tool === 'search' || tool === 'list' || tool === 'glob') return 'R1';
  return 'R2';
}

export interface DshEventRunnerOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly approvalPlugin?: string;
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export class DshJsonRunner implements DshEventRunner {
  private readonly command: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly approvalPlugin?: string;
  private readonly patchPaths = new Map<string, string | undefined>();

  constructor(options: DshEventRunnerOptions = {}) {
    this.command = options.command ?? process.env.DSH_HEADLESS_COMMAND ?? 'dsh';
    this.cwd = options.cwd ?? process.env.OPSAGENT_WORKSPACE_ROOT ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.approvalPlugin =
      options.approvalPlugin ??
      process.env.OPSAGENT_APPROVAL_PLUGIN ??
      fileURLToPath(new URL('../../runtime/ops-approval-bridge.mjs', import.meta.url));
  }

  private patch(model?: string): string | undefined {
    const key = model ?? '';
    if (this.patchPaths.has(key)) return this.patchPaths.get(key);
    const approvalExists = existsSync(this.approvalPlugin ?? '');
    const accountAuth = process.env.DSH_ACCOUNT_AUTH === 'true';
    if (!approvalExists && !accountAuth) {
      this.patchPaths.set(key, undefined);
      return undefined;
    }
    const dir = mkdtempSync(join(tmpdir(), 'opsagent-approval-'));
    const path = join(dir, 'patch.yml');
    const sections: string[] = [];
    if (accountAuth) {
      sections.push(
        [
          '- id: credentials',
          '  disabled: false',
          '- id: authorization',
          '  disabled: false',
          '- id: deepseek-account',
          '  disabled: false',
          '- id: agent-default-model',
          '  config:',
          '    provider: deepseek-account',
          `    model: ${model || process.env.DSH_ACCOUNT_MODEL || 'deepseek-flash'}`,
        ].join('\n'),
      );
    }
    if (approvalExists && this.approvalPlugin) {
      sections.push(
        [
          '- insert:',
          '    - id: ops-approval-bridge',
          `      name: '${this.approvalPlugin.replaceAll('\\', '/')}'`,
        ].join('\n'),
      );
    }
    writeFileSync(path, `${sections.join('\n')}\n`, 'utf8');
    this.patchPaths.set(key, path);
    return path;
  }

  async *run(
    prompt: string,
    sessionId?: string,
    env: Readonly<Record<string, string>> = {},
  ): AsyncIterable<Record<string, unknown>> {
    const args = ['--profile', 'headless'];
    const patch = this.patch(env.DSH_ACCOUNT_MODEL);
    if (patch) args.push('--patch', patch);
    args.push('headless', '--json');
    if (sessionId) args.push('--session-id', sessionId);
    args.push(prompt);
    const child =
      process.platform === 'win32'
        ? spawn(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', `${this.command} ${args.map(quoteArg).join(' ')}`],
            {
              cwd: this.cwd,
              env: { ...process.env, ...env },
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          )
        : spawn(this.command, args, {
            cwd: this.cwd,
            env: { ...process.env, ...env },
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

    const timer = setTimeout(() => child.kill(), this.timeoutMs);
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
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

  constructor(
    private readonly runner: DshEventRunner = new DshJsonRunner(),
    private readonly modelResolver?: DshModelResolver,
  ) {}

  async startSession(input: StartSessionInput): Promise<RuntimeSession> {
    const session: RuntimeSession = {
      runtimeSessionId: `dsh-${randomUUID()}`,
      tenantId: input.tenantId,
      userId: input.userId,
    };
    this.sessions.set(session.runtimeSessionId, session);
    return session;
  }

  async attachSession(runtimeSessionId: string, input: { tenantId: string; userId: string }, dshSessionId?: string): Promise<void> {
    if (!this.sessions.has(runtimeSessionId)) {
      this.sessions.set(runtimeSessionId, {
        runtimeSessionId,
        tenantId: input.tenantId,
        userId: input.userId,
      });
    }
    if (dshSessionId) this.dshSessionIds.set(runtimeSessionId, dshSessionId);
  }

  getSessionRef(runtimeSessionId: string): string | undefined {
    return this.dshSessionIds.get(runtimeSessionId);
  }

  async *prompt(sessionId: string, text: string, _idempotencyKey: string, options?: PromptOptions): AsyncIterable<RuntimeEvent> {
    const runtimeSession = this.sessions.get(sessionId);
    if (!runtimeSession) throw new Error(`unknown session: ${sessionId}`);
    let done = false;
    const toolNames = new Map<string, string>();
    const model = this.modelResolver ? await this.modelResolver(runtimeSession.tenantId, options?.modelId) : null;
    const modelEnv =
      model && (model.provider === 'deepseek' || model.provider === 'openai')
        ? {
            DEEPSEEK_API_KEY: model.apiKey,
            DEEPSEEK_BASE_URL: model.baseUrl,
            DEEPSEEK_MODEL: model.model,
            DSH_ACCOUNT_MODEL: model.model,
          }
        : {};
    const permissionMode: PermissionMode = options?.permissionMode ?? 'danger-full-access';
    const sandboxMode = permissionMode === 'auto-review' ? 'danger-full-access' : permissionMode;
    for await (const event of this.runner.run(text, this.dshSessionIds.get(sessionId), {
      ...modelEnv,
      DSH_PERMISSION_MODE: sandboxMode,
      OPSAGENT_PERMISSION_MODE: permissionMode,
      OPSAGENT_TENANT_ID: runtimeSession.tenantId,
      OPSAGENT_SESSION_ID: sessionId,
      OPSAGENT_CONTROL_URL: process.env.OPSAGENT_CONTROL_URL ?? 'http://127.0.0.1:8080',
      ...(process.env.OPSAGENT_INTERNAL_TOKEN
        ? { OPSAGENT_INTERNAL_TOKEN: process.env.OPSAGENT_INTERNAL_TOKEN }
        : {}),
    })) {
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
