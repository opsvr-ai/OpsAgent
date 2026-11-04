import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  PromptOptions,
  RuntimeClient,
  RuntimeEvent,
  RuntimeSession,
  StartSessionInput,
} from '@opsagent/contracts';

interface PendingApproval {
  readonly sessionId: string;
  readonly resolve: (decision: ApprovalDecision) => void;
}

export class FakeRuntime implements RuntimeClient {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly approvals = new Map<string, PendingApproval>();

  async startSession(input: StartSessionInput): Promise<RuntimeSession> {
    const session: RuntimeSession = {
      runtimeSessionId: `fake-${randomUUID()}`,
      tenantId: input.tenantId,
      userId: input.userId,
    };
    this.sessions.set(session.runtimeSessionId, session);
    return session;
  }

  async *prompt(
    sessionId: string,
    text: string,
    _idempotencyKey: string,
    _options?: PromptOptions,
  ): AsyncIterable<RuntimeEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);

    const at = new Date().toISOString();
    yield { type: 'assistant.delta', sessionId, at, text: `checking: ${text}` };

    if (text.toLowerCase().includes('restart')) {
      const approvalId = `approval-${randomUUID()}`;
      const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
        this.approvals.set(approvalId, { sessionId, resolve });
      });
      yield {
        type: 'approval.request',
        sessionId,
        at: new Date().toISOString(),
        approvalId,
        action: 'mock.restart',
        risk: 'R2',
      };
      const decision = await decisionPromise;
      this.approvals.delete(approvalId);

      if (decision === 'deny') {
        yield { type: 'session.done', sessionId, at: new Date().toISOString() };
        return;
      }

      yield {
        type: 'tool.call',
        sessionId,
        at: new Date().toISOString(),
        tool: 'mock.restart',
        args: {},
        risk: 'R2',
      };
      yield {
        type: 'tool.result',
        sessionId,
        at: new Date().toISOString(),
        tool: 'mock.restart',
        result: { restarted: true },
      };
      yield { type: 'session.done', sessionId, at: new Date().toISOString() };
      return;
    }

    yield {
      type: 'tool.call',
      sessionId,
      at: new Date().toISOString(),
      tool: 'mock.echo',
      args: { text },
      risk: 'R0',
    };
    yield {
      type: 'tool.result',
      sessionId,
      at: new Date().toISOString(),
      tool: 'mock.echo',
      result: { text },
    };
    yield { type: 'session.done', sessionId, at: new Date().toISOString() };
  }

  async respondApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    _reason?: string,
  ): Promise<void> {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error(`unknown approval: ${approvalId}`);
    if (pending.sessionId !== sessionId) throw new Error('approval session mismatch');
    pending.resolve(decision);
  }

  async resume(_sessionId: string): Promise<void> {}

  async close(): Promise<void> {
    for (const pending of this.approvals.values()) pending.resolve('deny');
    this.approvals.clear();
    this.sessions.clear();
  }
}

export type { ApprovalRequestEvent };
