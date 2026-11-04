import type { HomeResponse, MeResponse, PermissionMode, RuntimeEvent } from '@opsagent/contracts';
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

export async function loginLocalAdmin(username: string, password: string, remember = false): Promise<void> {
  await request<{ ok: true }>('/api/auth/local-admin', {
    method: 'POST',
    body: JSON.stringify({ username, password, remember }),
  });
}

export async function loginLdap(username: string, password: string, remember = false): Promise<void> {
  await request<{ ok: true }>('/api/auth/ldap', {
    method: 'POST',
    body: JSON.stringify({ username, password, remember }),
  });
}

export async function logout(): Promise<void> {
  await request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
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
  permissionMode?: PermissionMode,
): AsyncIterable<RuntimeEvent> {
  const response = await fetch(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, idempotencyKey, ...(permissionMode ? { permissionMode } : {}) }),
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

export async function createScenario(input: {
  name: string;
  description?: string;
  definition: { steps: Array<{ name: string; tool: string; input: Record<string, unknown> }> };
}): Promise<ScenarioSummary> {
  return request<ScenarioSummary>('/api/scenarios', {
    method: 'POST',
    body: JSON.stringify(input),
  });
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

export async function listAudit(
  limit = 50,
  filters: { action?: string; result?: string } = {},
): Promise<AuditEventSummary[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.action) params.set('action', filters.action);
  if (filters.result) params.set('result', filters.result);
  return request<AuditEventSummary[]>(`/api/audit?${params.toString()}`);
}

export interface ScenarioShare {
  readonly id: string;
  readonly scenarioId: string;
  readonly scenarioName?: string | null;
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

export interface IncidentEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface IncidentDetail {
  readonly incident: IncidentSummary;
  readonly events: readonly IncidentEvent[];
}

export async function getIncident(id: string): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/api/incidents/${id}`);
}

export interface ApprovalSummary {
  readonly id: string;
  readonly action: string;
  readonly risk: string;
  readonly sessionId: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export async function listApprovals(sessionId?: string): Promise<ApprovalSummary[]> {
  return request<ApprovalSummary[]>(
    `/api/approvals${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
  );
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

export interface ConnectorDetail extends ConnectorSummary {
  readonly hasCredentials: boolean;
}

export async function getConnector(id: string): Promise<ConnectorDetail> {
  return request<ConnectorDetail>(`/api/connectors/${id}`);
}

export async function saveConnectorCredentials(
  id: string,
  credentials: Readonly<Record<string, unknown>>,
): Promise<void> {
  await request<{ ok: true }>(`/api/connectors/${id}/credentials`, {
    method: 'PUT',
    body: JSON.stringify({ credentials }),
  });
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

export interface KnowledgeDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: string;
}

export async function listKnowledge(query?: string): Promise<KnowledgeDocument[]> {
  return request<KnowledgeDocument[]>(
    `/api/knowledge${query ? `?q=${encodeURIComponent(query)}` : ''}`,
  );
}

export async function createKnowledge(input: {
  title: string;
  body: string;
}): Promise<KnowledgeDocument> {
  return request<KnowledgeDocument>('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function publishKnowledge(id: string): Promise<KnowledgeDocument> {
  return request<KnowledgeDocument>(`/api/knowledge/${id}/publish`, { method: 'POST' });
}

export interface MessageSummary {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export async function listMessages(): Promise<MessageSummary[]> {
  return request<MessageSummary[]>('/api/messages');
}

export async function markMessageRead(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/messages/${id}/read`, { method: 'POST' });
}

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly os: string;
  readonly arch: string;
  readonly version: string;
  readonly status: string;
  readonly lastSeen: string;
  readonly metrics: Readonly<Record<string, unknown>>;
}

export async function listAgents(): Promise<AgentSummary[]> {
  return request<AgentSummary[]>('/api/agents');
}

export interface AgentCommandSummary {
  readonly id: string;
  readonly agentId: string;
  readonly type: string;
  readonly status: string;
  readonly result: unknown;
  readonly createdAt: string;
}

export async function listAgentCommands(agentId: string): Promise<AgentCommandSummary[]> {
  return request<AgentCommandSummary[]>(`/api/agents/${agentId}/commands`);
}

export async function createAgentCommand(
  agentId: string,
  type: string,
): Promise<AgentCommandSummary> {
  return request<AgentCommandSummary>(`/api/agents/${agentId}/commands`, {
    method: 'POST',
    body: JSON.stringify({ type }),
  });
}

export async function getAgentInstallCommand(
  os: 'linux' | 'windows',
): Promise<{ os: string; command: string }> {
  return request<{ os: string; command: string }>(`/api/agents/install-command?os=${os}`);
}

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly scenarioId: string;
  readonly scenarioName?: string | null;
  readonly status: string;
  readonly runId: string | null;
  readonly error: string | null;
}

export async function listTasks(): Promise<TaskSummary[]> {
  return request<TaskSummary[]>('/api/tasks');
}

export async function createTask(input: {
  title: string;
  scenarioId: string;
}): Promise<TaskSummary> {
  return request<TaskSummary>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function approveTask(
  id: string,
  decision: 'approve' | 'reject',
): Promise<TaskSummary> {
  return request<TaskSummary>(`/api/tasks/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly roleView: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly messageCount: number;
}

export type SessionTranscriptItem =
  | { readonly id: string; readonly kind: 'user'; readonly text: string; readonly at: string }
  | { readonly id: string; readonly kind: 'event'; readonly event: RuntimeEvent; readonly at: string };

export async function getSessionTranscript(id: string): Promise<SessionTranscriptItem[]> {
  const body = await request<{ items: SessionTranscriptItem[] }>(`/api/sessions/${id}/transcript`);
  return body.items;
}

export async function listSessions(): Promise<SessionSummary[]> {
  return request<SessionSummary[]>('/api/sessions');
}

export interface MemberSummary {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly roles: readonly string[];
}

export async function listMembers(): Promise<MemberSummary[]> {
  return request<MemberSummary[]>('/api/members');
}

export async function setMemberRoles(
  userId: string,
  roleIds: readonly string[],
): Promise<MemberSummary> {
  return request<MemberSummary>(`/api/members/${userId}/roles`, {
    method: 'PATCH',
    body: JSON.stringify({ roleIds }),
  });
}

export interface ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly status: string;
}

export async function listModels(): Promise<ModelProvider[]> {
  return request<ModelProvider[]>('/api/models');
}

export async function createModel(input: {
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}): Promise<ModelProvider> {
  return request<ModelProvider>('/api/models', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteModel(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/models/${id}`, { method: 'DELETE' });
}

export async function selectTenant(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/tenants/${id}/select`, { method: 'POST' });
}

export interface PlatformTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

export async function listPlatformTenants(): Promise<PlatformTenant[]> {
  return request<PlatformTenant[]>('/api/platform/tenants');
}

export async function createPlatformTenant(input: {
  name: string;
  slug: string;
}): Promise<PlatformTenant> {
  return request<PlatformTenant>('/api/platform/tenants', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface DataStoreSnapshot {
  readonly id: string;
  readonly tool: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface DataStoreDataset {
  readonly tool: string;
  readonly count: number;
  readonly bytes: number;
  readonly lastSync: string | null;
}

export interface DataStoreStats {
  readonly count: number;
  readonly bytes: number;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly quotaBytes: number;
  readonly usagePct: number;
  readonly datasets: readonly DataStoreDataset[];
  readonly recent: readonly DataStoreSnapshot[];
}

export async function getDataStore(): Promise<DataStoreStats> {
  return request<DataStoreStats>('/api/data-store');
}

export interface DataStoreSettings {
  readonly priority: string;
  readonly syncInterval: string;
  readonly fullSyncAt: string;
  readonly freshnessSec: number;
  readonly retentionDays: number;
}

export async function getDataStoreSettings(): Promise<DataStoreSettings> {
  return request<DataStoreSettings>('/api/data-store/settings');
}

export async function saveDataStoreSettings(
  input: DataStoreSettings,
): Promise<DataStoreSettings> {
  return request<DataStoreSettings>('/api/data-store/settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function cleanupDataStore(
  beforeDays: number,
  dryRun: boolean,
): Promise<{ count: number; bytes: number; dryRun: boolean }> {
  return request<{ count: number; bytes: number; dryRun: boolean }>('/api/data-store/cleanup', {
    method: 'POST',
    body: JSON.stringify({ beforeDays, dryRun }),
  });
}
