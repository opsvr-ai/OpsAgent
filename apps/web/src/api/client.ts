import type { HomeResponse, MeResponse, RuntimeEvent } from '@opsagent/contracts';
import { readSse } from './sse.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (response.status === 401) throw new ApiError(401, 'unauthorized');
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? 'request_failed');
  }
  return (await response.json()) as T;
}

export async function loginLocalAdmin(username: string, password: string): Promise<void> {
  await request<{ ok: true }>('/api/auth/local-admin', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>('/api/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function getHome(): Promise<HomeResponse> {
  return request<HomeResponse>('/api/home');
}

export async function createSession(
  tenantId: string,
  roleView: string,
): Promise<{ sessionId: string }> {
  return request<{ sessionId: string }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ tenantId, roleView }),
  });
}

export async function* promptSession(
  sessionId: string,
  text: string,
  idempotencyKey: string,
): AsyncIterable<RuntimeEvent> {
  const response = await fetch(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, idempotencyKey }),
  });
  if (!response.ok || !response.body) throw new ApiError(response.status, 'prompt_failed');
  yield* readSse(response.body);
}

export async function decideApproval(
  approvalId: string,
  decision: 'approve' | 'deny',
  reason?: string,
): Promise<void> {
  await request<{ ok: true }>(`/api/approvals/${approvalId}`, {
    method: 'POST',
    body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
  });
}

export interface ScenarioSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly version: number;
  readonly definition: { readonly steps: readonly unknown[] };
  readonly scheduleIntervalMinutes?: number | null;
}

export interface ScenarioRunSummary {
  readonly status: 'success' | 'failed';
  readonly results: readonly unknown[];
  readonly error?: string;
}

export async function listScenarios(): Promise<ScenarioSummary[]> {
  return request<ScenarioSummary[]>('/api/scenarios');
}

export async function runScenario(id: string): Promise<ScenarioRunSummary> {
  return request<ScenarioRunSummary>(`/api/scenarios/${id}/run`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function setScenarioSchedule(
  id: string,
  intervalMinutes: number | null,
): Promise<void> {
  await request<{ ok: true }>(`/api/scenarios/${id}/schedule`, {
    method: 'PATCH',
    body: JSON.stringify({ intervalMinutes }),
  });
}

export interface AuditEventSummary {
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly resource: string | null;
  readonly result: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export async function listAudit(limit = 50): Promise<AuditEventSummary[]> {
  return request<AuditEventSummary[]>(`/api/audit?limit=${limit}`);
}
