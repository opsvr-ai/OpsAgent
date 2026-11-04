import type {
  ApprovalId,
  RuntimeSessionId,
  SessionId,
  TenantId,
  UserId,
} from './ids.js';

export const RUNTIME_EVENT_TAGS = [
  'assistant.delta',
  'tool.call',
  'tool.result',
  'approval.request',
  'session.done',
  'runtime.error',
] as const;

export type RuntimeEventTag = (typeof RUNTIME_EVENT_TAGS)[number];
export type ApprovalDecision = 'approve' | 'deny';

export const PERMISSION_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
  'auto-review',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface PromptOptions {
  readonly permissionMode?: PermissionMode;
}

export interface AttachSessionInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface StartSessionInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly roleView: string;
  readonly scenarioId?: string;
}

export interface RuntimeSession {
  readonly runtimeSessionId: RuntimeSessionId;
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface RuntimeEventBase {
  readonly type: RuntimeEventTag;
  readonly sessionId: SessionId;
  readonly at: string;
}

export interface AssistantDeltaEvent extends RuntimeEventBase {
  readonly type: 'assistant.delta';
  readonly text: string;
}

export interface ToolCallEvent extends RuntimeEventBase {
  readonly type: 'tool.call';
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly risk: 'R0' | 'R1' | 'R2' | 'R3';
}

export interface ToolResultEvent extends RuntimeEventBase {
  readonly type: 'tool.result';
  readonly tool: string;
  readonly result: unknown;
}

export interface ApprovalRequestEvent extends RuntimeEventBase {
  readonly type: 'approval.request';
  readonly approvalId: ApprovalId;
  readonly action: string;
  readonly risk: 'R2' | 'R3';
}

export interface SessionDoneEvent extends RuntimeEventBase {
  readonly type: 'session.done';
}

export interface RuntimeErrorEvent extends RuntimeEventBase {
  readonly type: 'runtime.error';
  readonly code: string;
  readonly message: string;
}

export type RuntimeEvent =
  | AssistantDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | SessionDoneEvent
  | RuntimeErrorEvent;

export interface RuntimeClient {
  startSession(input: StartSessionInput): Promise<RuntimeSession>;
  prompt(
    sessionId: SessionId,
    text: string,
    idempotencyKey: string,
    options?: PromptOptions,
  ): AsyncIterable<RuntimeEvent>;
  /** Reattach a persisted session after a control-plane restart. */
  attachSession?(
    runtimeSessionId: RuntimeSessionId,
    input: AttachSessionInput,
    dshSessionId?: string,
  ): Promise<void>;
  /** The underlying dsh session id after the first prompt. */
  getSessionRef?(runtimeSessionId: RuntimeSessionId): string | undefined;
  respondApproval(
    sessionId: SessionId,
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void>;
  resume(sessionId: SessionId): Promise<void>;
  close(): Promise<void>;
}
