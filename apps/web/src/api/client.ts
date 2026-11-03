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
  readonly status: 'success' | 'failed' | 'awaiting_approval';
  readonly runId: string;
  readonly results: readonly unknown[];
  readonly approvalId?: string;
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

export async function approveScenarioRun(
  runId: string,
  decision: 'approve' | 'reject',
): Promise<ScenarioRunSummary> {
  return request<ScenarioRunSummary>(`/api/scenario-runs/${runId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
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

export interface ScenarioShare {
  readonly id: string;
  readonly scenarioId: string;
  readonly scope: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly reviewerId: string | null;
  readonly reason: string | null;
}

export async function listShares(): Promise<ScenarioShare[]> {
  return request<ScenarioShare[]>('/api/shares');
}

export async function reviewShare(
  id: string,
  decision: 'approve' | 'reject',
  reason?: string,
): Promise<ScenarioShare> {
  return request<ScenarioShare>(`/api/shares/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
  });
}

export interface StudioSession {
  readonly id: string;
  readonly goal: string;
  readonly platform: string;
  readonly status: string;
  readonly bundle: {
    readonly goal: string;
    readonly files: readonly string[];
    readonly manifest: Readonly<Record<string, unknown>>;
  } | null;
}

export async function listStudioSessions(): Promise<StudioSession[]> {
  return request<StudioSession[]>('/api/studio/sessions');
}

export async function createStudioSession(input: {
  goal: string;
  platform: string;
}): Promise<StudioSession> {
  return request<StudioSession>('/api/studio/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function submitStudioSession(id: string): Promise<StudioSession> {
  return request<StudioSession>(`/api/studio/sessions/${id}/submit`, { method: 'POST' });
}

export async function reviewStudioSession(
  id: string,
  decision: 'approve' | 'reject',
): Promise<StudioSession> {
  return request<StudioSession>(`/api/studio/sessions/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

export interface IncidentSummary {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly commanderId: string | null;
}

export async function listIncidents(): Promise<IncidentSummary[]> {
  return request<IncidentSummary[]>('/api/incidents');
}

export async function createIncident(input: {
  title: string;
  severity: string;
}): Promise<IncidentSummary> {
  return request<IncidentSummary>('/api/incidents', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateIncident(
  id: string,
  patch: { status?: string; commanderId?: string | null },
): Promise<IncidentSummary> {
  return request<IncidentSummary>(`/api/incidents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export interface ApprovalSummary {
  readonly id: string;
  readonly action: string;
  readonly risk: string;
  readonly sessionId: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export async function listApprovals(): Promise<ApprovalSummary[]> {
  return request<ApprovalSummary[]>('/api/approvals');
}

export interface ConnectorSummary {
  readonly id: string;
  readonly name: string;
  readonly connectorType: string;
  readonly status: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialRef: string | null;
}

export async function listConnectors(): Promise<ConnectorSummary[]> {
  return request<ConnectorSummary[]>('/api/connectors');
}

export async function createConnector(input: {
  connectorType: string;
  name: string;
  config: Readonly<Record<string, unknown>>;
}): Promise<ConnectorSummary> {
  return request<ConnectorSummary>('/api/connectors', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function testConnector(
  id: string,
): Promise<{ status: string; latencyMs: number }> {
  return request<{ status: string; latencyMs: number }>(`/api/connectors/${id}/test`, {
    method: 'POST',
  });
}
