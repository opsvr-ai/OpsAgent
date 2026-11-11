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
  modelId?: string,
): AsyncIterable<RuntimeEvent> {
  const response = await fetch(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      idempotencyKey,
      ...(permissionMode ? { permissionMode } : {}),
      ...(modelId ? { modelId } : {}),
    }),
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
  readonly source?: string;
  readonly appSystemId?: string | null;
  readonly rootCause?: string | null;
  readonly dueAt?: string | null;
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
  readonly evidence?: readonly IncidentEvidence[];
  readonly hypotheses?: readonly IncidentHypothesis[];
  readonly tickets?: readonly IncidentTicket[];
  readonly approvals?: readonly IncidentApproval[];
}

export interface IncidentInstruction {
  readonly instructionId: string;
  readonly hostname: string;
  readonly instruction: string | null;
  readonly status: string;
  readonly answer: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface IncidentEvidence {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface IncidentHypothesis {
  readonly id: string;
  readonly statement: string;
  readonly confidence: number;
  readonly status: string;
  readonly createdAt: string;
}

export interface IncidentTicket {
  readonly id: string;
  readonly title: string;
  readonly assignee: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface IncidentApproval {
  readonly id: string;
  readonly action: string;
  readonly risk: string;
  readonly status: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export async function getIncident(id: string): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/api/incidents/${id}`);
}

export async function getIncidentInstructions(id: string): Promise<IncidentInstruction[]> {
  return request<IncidentInstruction[]>(`/api/incidents/${id}/instructions`);
}

export async function investigateIncident(id: string): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/api/incidents/${id}/investigate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function recheckIncident(id: string): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/api/incidents/${id}/recheck`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function requestIncidentApproval(
  id: string,
  input: { action: string; risk: 'R2' | 'R3'; details?: Record<string, unknown> },
): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/api/incidents/${id}/approvals`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function decideIncidentApproval(
  id: string,
  approvalId: string,
  decision: 'approve' | 'deny',
  reason?: string,
): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/api/incidents/${id}/approvals/${approvalId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, reason }),
  });
}

export interface IncidentAnalysisResult {
  readonly analysis: string;
  readonly detail: IncidentDetail;
}

export async function analyzeIncident(id: string): Promise<IncidentAnalysisResult> {
  return request<IncidentAnalysisResult>(`/api/incidents/${id}/analyze`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface IncidentReportTemplate {
  readonly body: string;
  readonly custom: boolean;
  readonly updatedAt: string | null;
}

export async function getIncidentReportTemplate(): Promise<IncidentReportTemplate> {
  return request<IncidentReportTemplate>('/api/incident-report-templates');
}

export async function saveIncidentReportTemplate(body: string): Promise<IncidentReportTemplate> {
  return request<IncidentReportTemplate>('/api/incident-report-templates', {
    method: 'PUT',
    body: JSON.stringify({ body }),
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

export interface AgentApplication {
  readonly name?: string;
  readonly kind?: string;
  readonly version?: string;
  readonly status?: string;
  readonly deploy?: string;
  readonly ports?: unknown;
  readonly path?: string;
}

export interface AppSystemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly owner: string | null;
  readonly criticality: string;
  readonly agentCount: number;
  readonly onlineCount: number;
}

export interface AgentEventSummary {
  readonly id: string;
  readonly agentId: string;
  readonly hostname?: string;
  readonly fingerprint: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly detail: string;
  readonly metric: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly detectedAt: string;
  readonly resolvedAt: string | null;
}

export interface AppHealthFinding {
  readonly agentId: string;
  readonly hostname: string;
  readonly status: 'healthy' | 'warning' | 'critical' | 'offline';
  readonly issues: string[];
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly applications: readonly unknown[];
  readonly events: readonly string[];
  readonly logSignals: readonly string[];
}

export interface AppHealthCheck {
  readonly id: string;
  readonly appSystemId: string;
  readonly appSystemName: string;
  readonly status: string;
  readonly summary: string;
  readonly rootCause: string;
  readonly findings: readonly AppHealthFinding[];
  readonly createdAt: string;
  readonly completedAt: string | null;
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
  readonly systemInfo: Readonly<Record<string, unknown>>;
  readonly applications: readonly AgentApplication[];
  readonly agentInfo: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly discoveryAt: string | null;
  readonly commandKeyId?: string | null;
  readonly tlsCertExpiresAt?: string | null;
  readonly tlsCertSerial?: string | null;
  readonly appSystem: AppSystemSummary | null;
}

export interface AgentInstructionIntent {
  readonly kind: string;
  readonly readOnly: boolean;
  readonly confidence: number;
  readonly params?: { readonly question?: string };
}

export interface AgentInstructionCreated {
  readonly approvalId?: string;
  readonly instructionId?: string;
  readonly commandId?: string;
  readonly agentId: string;
  readonly hostname: string;
  readonly status: string;
  readonly intent: AgentInstructionIntent;
}

export interface AgentInstructionApproval {
  readonly id: string;
  readonly agentId: string;
  readonly hostname: string;
  readonly instruction: string;
  readonly action: string;
  readonly service: string | null;
  readonly risk: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly decidedBy?: string | null;
  readonly decisionReason?: string | null;
  readonly commandId?: string | null;
  readonly createdAt: string;
  readonly decidedAt?: string | null;
  readonly expiresAt?: string | null;
}

export interface AgentInstructionDetail {
  readonly instructionId: string;
  readonly commandId: string;
  readonly status: string;
  readonly instruction: string | null;
  readonly intent: AgentInstructionIntent | null;
  readonly answer: string;
  readonly evidence: Readonly<Record<string, unknown>> | null;
  readonly toolsUsed: readonly string[] | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export async function createAgentInstruction(
  agentId: string,
  instruction: string,
  clientRequestId: string,
  incidentId?: string,
): Promise<AgentInstructionCreated> {
  return request<AgentInstructionCreated>(`/api/agents/${agentId}/instructions`, {
    method: 'POST',
    body: JSON.stringify({ instruction, clientRequestId, ...(incidentId ? { incidentId } : {}) }),
  });
}

export async function getAgentInstruction(
  agentId: string,
  instructionId: string,
): Promise<AgentInstructionDetail> {
  return request<AgentInstructionDetail>(`/api/agents/${agentId}/instructions/${instructionId}`);
}

export async function listAgentInstructions(agentId: string): Promise<AgentInstructionDetail[]> {
  return request<AgentInstructionDetail[]>(`/api/agents/${agentId}/instructions`);
}

export async function cancelAgentInstruction(agentId: string, instructionId: string): Promise<void> {
  await request<{ ok: true }>(`/api/agents/${agentId}/instructions/${instructionId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface AgentBatchInstructionCreated {
  readonly intent: AgentInstructionIntent;
  readonly instructions?: Array<{
    readonly agentId: string;
    readonly hostname: string;
    readonly instructionId: string;
    readonly status: string;
  }>;
  readonly approvals?: Array<{
    readonly approvalId: string;
    readonly agentId: string;
    readonly hostname: string;
    readonly status: string;
  }>;
}

export async function createAgentInstructionsBatch(
  agentIds: string[],
  instruction: string,
): Promise<AgentBatchInstructionCreated> {
  return request<AgentBatchInstructionCreated>('/api/agents/instructions', {
    method: 'POST',
    body: JSON.stringify({ agentIds, instruction }),
  });
}

export async function listAgentInstructionApprovals(
  status: 'pending' | 'decided' = 'pending',
): Promise<AgentInstructionApproval[]> {
  return request<AgentInstructionApproval[]>(
    `/api/agent-instruction-approvals${status === 'decided' ? '?status=decided' : ''}`,
  );
}

export async function decideAgentInstructionApproval(
  id: string,
  decision: 'approve' | 'deny',
  reason?: string,
): Promise<void> {
  await request<{ status: string }>(`/api/agent-instruction-approvals/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
  });
}

export async function decideAgentInstructionApprovals(
  approvalIds: string[],
  decision: 'approve' | 'deny',
  reason?: string,
): Promise<Array<{ approvalId: string; statusCode: number; result: Record<string, unknown> }>> {
  const response = await request<{
    results: Array<{ approvalId: string; statusCode: number; result: Record<string, unknown> }>;
  }>('/api/agent-instruction-approvals/batch-decision', {
    method: 'POST',
    body: JSON.stringify({ approvalIds, decision, ...(reason ? { reason } : {}) }),
  });
  return response.results;
}

export async function cancelAgentInstructionApproval(id: string): Promise<void> {
  await request<{ status: string }>(`/api/agent-instruction-approvals/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface ApprovalWebhookDelivery {
  readonly id: string;
  readonly eventType: string;
  readonly approvalId: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export async function listApprovalWebhookDeliveries(
  status: 'failed' | 'delivered' = 'failed',
): Promise<ApprovalWebhookDelivery[]> {
  return request<ApprovalWebhookDelivery[]>(
    `/api/agent-instruction-approvals/webhook-deliveries?status=${status}`,
  );
}

export async function replayApprovalWebhookDelivery(id: string): Promise<void> {
  await request<{ status: string }>(`/api/agent-instruction-approvals/webhook-deliveries/${id}/replay`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface ApprovalSideEffectFailure {
  readonly id: string;
  readonly approvalId: string | null;
  readonly effect: string;
  readonly error: string | null;
  readonly createdAt: string;
}

export async function listApprovalSideEffectFailures(): Promise<ApprovalSideEffectFailure[]> {
  return request<ApprovalSideEffectFailure[]>('/api/agent-instruction-approvals/side-effect-failures');
}

export interface OperationsAlertDelivery {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export async function listOperationsAlertDeliveries(): Promise<OperationsAlertDelivery[]> {
  return request<OperationsAlertDelivery[]>('/api/agent-instruction-approvals/operations-alert-deliveries');
}

export async function replayOperationsAlertDelivery(id: string): Promise<void> {
  await request<{ status: string }>(`/api/agent-instruction-approvals/operations-alert-deliveries/${id}/replay`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface NotificationStatPoint {
  readonly hour: string;
  readonly approvalDelivered: number;
  readonly approvalFailed: number;
  readonly operationsDelivered: number;
  readonly operationsFailed: number;
}

export async function listNotificationStats(
  hours = 24,
  bucket?: 'hour' | 'day',
  from?: string,
  to?: string,
): Promise<NotificationStatPoint[]> {
  const query = new URLSearchParams({ hours: String(hours) });
  if (bucket) query.set('bucket', bucket);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  return request<NotificationStatPoint[]>(
    `/api/agent-instruction-approvals/notification-stats?${query.toString()}`,
  );
}

export async function resolveApprovalSideEffectFailure(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/agent-instruction-approvals/side-effect-failures/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function retryApprovalSideEffectFailure(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/agent-instruction-approvals/side-effect-failures/${id}/retry`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface AgentInstructionTemplate {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly scope: 'private' | 'tenant';
  readonly createdAt: string;
}

export async function listAgentInstructionTemplates(): Promise<AgentInstructionTemplate[]> {
  return request<AgentInstructionTemplate[]>('/api/agents/instruction-templates');
}

export async function createAgentInstructionTemplate(
  name: string,
  instruction: string,
  scope: 'private' | 'tenant' = 'tenant',
): Promise<AgentInstructionTemplate> {
  return request<AgentInstructionTemplate>('/api/agents/instruction-templates', {
    method: 'POST',
    body: JSON.stringify({ name, instruction, scope }),
  });
}

export async function deleteAgentInstructionTemplate(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/agents/instruction-templates/${id}`, { method: 'DELETE' });
}

export async function updateAgentInstructionTemplate(
  id: string,
  name: string,
  instruction: string,
  scope?: 'private' | 'tenant',
): Promise<AgentInstructionTemplate> {
  return request<AgentInstructionTemplate>(`/api/agents/instruction-templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, instruction, ...(scope ? { scope } : {}) }),
  });
}

export interface AgentFleetResponse {
  readonly items: AgentSummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly summary: {
    readonly total: number;
    readonly online: number;
    readonly offline: number;
    readonly appSystems: number;
    readonly applications: number;
    readonly discovered: number;
  };
  readonly appSystems: AppSystemSummary[];
  readonly alerts: AgentEventSummary[];
}

export async function listAgents(): Promise<AgentSummary[]> {
  return request<AgentSummary[]>('/api/agents');
}

export interface CommandKeyStatus {
  readonly keys: Array<{ keyId: string; publicKey: string; active: boolean }>;
  readonly agents: Array<{
    id: string;
    hostname: string;
    commandKeyId: string | null;
    valid: boolean | null;
  }>;
}

export async function getCommandKeyStatus(): Promise<CommandKeyStatus> {
  return request<CommandKeyStatus>('/api/agents/command-keys');
}

export async function getAgentFleet(params: {
  query?: string;
  status?: string;
  appSystemId?: string;
  os?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<AgentFleetResponse> {
  const search = new URLSearchParams();
  if (params.query) search.set('query', params.query);
  if (params.status) search.set('status', params.status);
  if (params.appSystemId) search.set('appSystemId', params.appSystemId);
  if (params.os) search.set('os', params.os);
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  return request<AgentFleetResponse>(`/api/agents/fleet?${search.toString()}`);
}

export async function getAgentDetail(id: string): Promise<AgentSummary> {
  return request<AgentSummary>(`/api/agents/${id}`);
}

export async function getAgentEvents(id: string): Promise<AgentEventSummary[]> {
  return request<AgentEventSummary[]>(`/api/agents/${id}/events`);
}

export async function getAppSystemHealth(): Promise<AppHealthCheck[]> {
  return request<AppHealthCheck[]>('/api/app-systems/health');
}

export async function listAppSystems(): Promise<AppSystemSummary[]> {
  return request<AppSystemSummary[]>('/api/app-systems');
}

export async function assignAgentAppSystem(id: string, appSystemId: string | null): Promise<AgentSummary> {
  return request<AgentSummary>(`/api/agents/${id}/app-system`, {
    method: 'PATCH',
    body: JSON.stringify({ appSystemId }),
  });
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

export interface ReleaseSummary {
  readonly id: string;
  readonly appSystemId: string | null;
  readonly version: string;
  readonly artifactUrl: string;
  readonly sha256: string;
  readonly status: string;
  readonly deployCommand: string | null;
  readonly rollbackCommand: string | null;
  readonly createdAt: string;
}

export interface DeploymentSummary {
  readonly id: string;
  readonly releaseId: string;
  readonly environment: string;
  readonly strategy: string;
  readonly canaryPercent: number | null;
  readonly status: string;
  readonly reason: string | null;
  readonly preflight: Readonly<Record<string, unknown>> | null;
  readonly execution: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
}

export async function listReleases(): Promise<ReleaseSummary[]> {
  return request<ReleaseSummary[]>('/api/releases');
}

export async function createRelease(input: {
  version: string;
  artifactUrl: string;
  sha256: string;
  signature: string;
  appSystemId?: string;
  deployCommand?: string;
  rollbackCommand?: string;
}): Promise<ReleaseSummary> {
  return request<ReleaseSummary>('/api/releases', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listDeployments(): Promise<DeploymentSummary[]> {
  return request<DeploymentSummary[]>('/api/deployments');
}

export async function createDeployment(input: {
  releaseId: string;
  environment: string;
  strategy: 'rolling' | 'canary';
  canaryPercent?: number;
}): Promise<DeploymentSummary> {
  return request<DeploymentSummary>('/api/deployments', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function decideDeployment(
  id: string,
  decision: 'approve' | 'reject',
): Promise<DeploymentSummary> {
  return request<DeploymentSummary>(`/api/deployments/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

export async function preflightDeployment(id: string): Promise<DeploymentSummary> {
  return request<DeploymentSummary>(`/api/deployments/${id}/preflight`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function executeDeployment(id: string): Promise<DeploymentSummary> {
  return request<DeploymentSummary>(`/api/deployments/${id}/execute`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function promoteDeployment(id: string): Promise<DeploymentSummary> {
  return request<DeploymentSummary>(`/api/deployments/${id}/promote`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function rollbackDeployment(id: string, reason: string): Promise<DeploymentSummary> {
  return request<DeploymentSummary>(`/api/deployments/${id}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export interface TrafficCanaryPolicy {
  readonly id: string;
  readonly deploymentId: string;
  readonly host: string;
  readonly stableUpstream: string;
  readonly canaryUpstream: string;
  readonly canaryWeight: number;
  readonly status: string;
  readonly updatedAt: string;
}

export async function getTrafficCanaryPolicy(id: string): Promise<TrafficCanaryPolicy> {
  return request<TrafficCanaryPolicy>(`/api/deployments/${id}/traffic-canary`);
}

export async function saveTrafficCanaryPolicy(id: string, input: {
  host: string;
  stableUpstream: string;
  canaryUpstream: string;
  canaryWeight: number;
}): Promise<TrafficCanaryPolicy> {
  return request<TrafficCanaryPolicy>(`/api/deployments/${id}/traffic-canary`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function setTrafficCanaryWeight(id: string, weight: number): Promise<TrafficCanaryPolicy> {
  return request<TrafficCanaryPolicy>(`/api/deployments/${id}/traffic-canary/weight`, {
    method: 'POST',
    body: JSON.stringify({ weight }),
  });
}

export async function fetchTrafficCanaryNginx(id: string): Promise<string> {
  const response = await fetch(`/api/deployments/${id}/traffic-canary/nginx`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new ApiError(response.status, 'traffic_canary_unavailable');
  return response.text();
}

export interface AgentPatrolPolicy {
  agentId: string;
  enabled: boolean;
  intervalSeconds: number;
  diskFreePct: number;
  memLoadPct: number;
  load1: number;
  updatedAt: string | null;
}

export async function getAgentPatrolPolicy(agentId: string): Promise<AgentPatrolPolicy> {
  return request<AgentPatrolPolicy>(`/api/agents/${agentId}/patrol-policy`);
}

export async function updateAgentPatrolPolicy(
  agentId: string,
  input: Omit<AgentPatrolPolicy, 'agentId' | 'updatedAt'>,
): Promise<AgentPatrolPolicy> {
  return request<AgentPatrolPolicy>(`/api/agents/${agentId}/patrol-policy`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export interface AgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly source: 'builtin' | 'custom';
  readonly checksum: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly assignments: Array<{ scope: string; targetId: string | null; targetName?: string }>;
}

export async function listAgentSkills(): Promise<AgentSkill[]> {
  return request<AgentSkill[]>('/api/skills');
}

export async function createAgentSkill(input: { name: string; description: string; content: string }): Promise<AgentSkill> {
  return request<AgentSkill>('/api/skills', { method: 'POST', body: JSON.stringify(input) });
}

export async function deleteAgentSkill(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/skills/${id}`, { method: 'DELETE' });
}

export async function assignAgentSkill(id: string, input: {
  scope: 'all' | 'app_system' | 'agent';
  targetId?: string;
}): Promise<{ synced: number; agents: string[] }> {
  return request<{ synced: number; agents: string[] }>(`/api/skills/${id}/assign`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createAppSystem(input: {
  code: string;
  name: string;
  owner?: string;
  criticality?: string;
}): Promise<AppSystemSummary> {
  return request<AppSystemSummary>('/api/app-systems', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface AppSystemAccessService {
  readonly name: string;
  readonly ports: readonly number[];
}

export interface AppSystemAccessNode {
  readonly hostname: string;
  readonly appSystemId: string | null;
  readonly appSystemName: string;
  readonly status: string;
  readonly ip: string;
  readonly anomalies: readonly string[];
  readonly services: readonly AppSystemAccessService[];
}

export interface AppSystemAccessEdge {
  readonly fromHost: string;
  readonly fromService: string;
  readonly fromPid: number;
  readonly toHost: string;
  readonly toService: string;
  readonly toPort: number;
  readonly toPid: number;
  readonly count: number;
  readonly protocol: string;
  readonly targetAppSystemId: string | null;
  readonly targetAppSystemName: string;
}

export interface AppSystemAccessTopology {
  readonly system: { id: string; name: string; code: string };
  readonly nodes: readonly AppSystemAccessNode[];
  readonly edges: readonly AppSystemAccessEdge[];
  readonly externalSystems: ReadonlyArray<{
    appSystemId: string;
    appSystemName: string;
    edges: readonly AppSystemAccessEdge[];
  }>;
  readonly stats: {
    collectedConnections: number;
    matchedEdges: number;
    skippedUnmanaged: number;
    skippedUnmappedPort: number;
    skippedInbound: number;
  };
}

export async function getAppSystemAccessTopology(id: string): Promise<AppSystemAccessTopology> {
  return request<AppSystemAccessTopology>(`/api/app-systems/${id}/access-topology`);
}

export interface FaultAnalysisSummary {
  readonly id: string;
  readonly appSystemId: string | null;
  readonly appSystemName: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string;
  readonly rootCause: string;
  readonly confidence: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface FaultTopologyNode {
  readonly id?: string;
  readonly hostname: string;
  readonly status: string;
  readonly ip?: string;
  readonly anomalies: string[];
  readonly processes: string[];
  readonly ports: string[];
}

export interface FaultTopologyEdge {
  readonly fromHost: string;
  readonly fromApp: string;
  readonly fromPort: number;
  readonly toHost: string;
  readonly toApp: string;
  readonly toPort: number;
  readonly protocol: string;
  readonly count: number;
}

export interface FaultTopology {
  readonly nodes: FaultTopologyNode[];
  readonly edges: FaultTopologyEdge[];
}

export interface FaultAnalysisDetail extends FaultAnalysisSummary {
  readonly findings: Array<{ title?: string; detail?: string; severity?: string }>;
  readonly evidence?: {
    readonly context?: {
      readonly appSystem?: string;
      readonly nodes?: Array<{ hostname: string; status: string; metrics?: Record<string, unknown> }>;
      readonly events?: Array<{ hostname: string; title: string; detail: string; severity: string }>;
      readonly topology?: FaultTopology;
    };
    readonly evidence?: Array<{ hostname: string; question: string; status: string; analysis?: string; answer?: string }>;
  };
  readonly steps: Array<{
    id: string; seq: number; type: string; title: string; detail: string; status: string; createdAt: string;
  }>;
}

export async function listFaultAnalyses(): Promise<FaultAnalysisSummary[]> {
  return request<FaultAnalysisSummary[]>('/api/fault-analyses');
}

export async function getFaultAnalysis(id: string): Promise<FaultAnalysisDetail> {
  return request<FaultAnalysisDetail>(`/api/fault-analyses/${id}`);
}

export async function createFaultAnalysis(appSystemId: string): Promise<{ id: string }> {
  return request<{ id: string }>('/api/fault-analyses', {
    method: 'POST',
    body: JSON.stringify({ appSystemId }),
  });
}

export interface AgentInventoryItem {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly detail: Record<string, unknown>;
  readonly important: boolean;
  readonly monitored: boolean;
  readonly appSystemId: string | null;
}

export async function getAgentInventory(agentId: string): Promise<AgentInventoryItem[]> {
  return request<AgentInventoryItem[]>(`/api/agents/${agentId}/inventory`);
}

export async function updateAgentInventory(
  agentId: string,
  itemId: string,
  input: { important?: boolean; monitored?: boolean; appSystemId?: string },
): Promise<AgentInventoryItem> {
  return request<AgentInventoryItem>(`/api/agents/${agentId}/inventory/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteAgentInventory(agentId: string, itemId: string): Promise<void> {
  await request<{ ok: true }>(`/api/agents/${agentId}/inventory/${itemId}`, { method: 'DELETE' });
}

export async function promoteAgentInventory(agentId: string, itemId: string): Promise<void> {
  await request<{ ok: true }>(`/api/agents/${agentId}/inventory/${itemId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'ops_tool' }),
  });
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
  readonly isAgentDefault: boolean;
}

export async function listModels(): Promise<ModelProvider[]> {
  return request<ModelProvider[]>('/api/models');
}

export async function listAvailableModels(): Promise<ModelProvider[]> {
  return request<ModelProvider[]>('/api/models/available');
}

export async function setModelAsAgentDefault(id: string): Promise<ModelProvider> {
  return request<ModelProvider>(`/api/models/${id}/default`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface DiscoveredModel {
  readonly id: string;
  readonly displayName?: string;
}

export async function discoverModels(input: {
  provider: string;
  baseUrl: string;
  apiKey: string;
}): Promise<DiscoveredModel[]> {
  const response = await request<{ models: DiscoveredModel[] }>('/api/models/discover', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.models;
}

export async function createModelsBatch(input: {
  name: string;
  provider: string;
  baseUrl: string;
  models: string[];
  apiKey: string;
}): Promise<ModelProvider[]> {
  return request<ModelProvider[]>('/api/models/batch', {
    method: 'POST',
    body: JSON.stringify(input),
  });
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

export async function updateModel(id: string, input: {
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  status?: 'active' | 'disabled';
}): Promise<ModelProvider> {
  return request<ModelProvider>(`/api/models/${id}`, {
    method: 'PATCH',
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

export interface PlatformTlsStatus {
  readonly configured: boolean;
  readonly subject?: string;
  readonly issuer?: string;
  readonly serialNumber?: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly daysRemaining?: number;
  readonly autoGenerated?: boolean;
  readonly error?: string;
}

export async function getPlatformTlsStatus(): Promise<PlatformTlsStatus> {
  return request<PlatformTlsStatus>('/api/platform/tls');
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

// ---------------------------------------------------------------------------
// 访问拓扑学习
// ---------------------------------------------------------------------------

import type {
  TopologyGraph,
  TopologyGraphSummary,
  TopologyLearningPolicy,
  TopologyLearningPolicyUpdate,
  TopologyLearningSession,
  TopologyEdgeTag,
  TopologyEdgeTagInput,
  AccessTrendsResponse,
  HttpRequestTrendsResponse,
  EdgeTagSuggestResponse,
  EdgeTagSuggestion,
  TopologyAdjustment,
  TopologyAdjustOperation,
} from '@opsagent/contracts';

function topologyQuery(appSystemId?: string): string {
  return appSystemId ? `?appSystemId=${encodeURIComponent(appSystemId)}` : '';
}

export async function getTopologyGraphs(): Promise<{ graphs: TopologyGraphSummary[] }> {
  return request<{ graphs: TopologyGraphSummary[] }>('/api/topologies');
}

export async function getLatestTopology(appSystemId?: string): Promise<TopologyGraph | null> {
  return request<TopologyGraph | null>(`/api/topologies/latest${topologyQuery(appSystemId)}`);
}

export interface ModelTestResult {
  readonly ok: boolean;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly sample?: string;
  readonly error?: string;
}

/** 模型连通性自检：返回真实错误（401/404/超时/响应格式等）。 */
export async function testModel(id: string): Promise<ModelTestResult> {
  return request<ModelTestResult>(`/api/models/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** 按拓扑分析同款「默认模型」解析做自检。 */
export async function testDefaultModel(): Promise<ModelTestResult & { provider?: string; baseUrl?: string }> {
  return request<ModelTestResult & { provider?: string; baseUrl?: string }>('/api/models/test-default', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getTopologyGraph(id: string): Promise<TopologyGraph> {
  return request<TopologyGraph>(`/api/topologies/${encodeURIComponent(id)}`);
}

export async function getTopologySession(id: string): Promise<TopologyLearningSession> {
  return request<TopologyLearningSession>(`/api/topologies/learn/${encodeURIComponent(id)}`);
}

export async function getActiveTopologySession(
  appSystemId?: string,
): Promise<TopologyLearningSession | null> {
  return request<TopologyLearningSession | null>(`/api/topologies/learn/active${topologyQuery(appSystemId)}`);
}

export async function startTopologyLearning(body: {
  appSystemId?: string | null;
  windowSeconds: number;
  includeUnassigned?: boolean;
}): Promise<TopologyLearningSession> {
  return request<TopologyLearningSession>('/api/topologies/learn', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function analyzeTopologySession(id: string): Promise<TopologyLearningSession> {
  return request<TopologyLearningSession>(`/api/topologies/learn/${encodeURIComponent(id)}/analyze`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function cancelTopologySession(id: string): Promise<TopologyLearningSession> {
  return request<TopologyLearningSession>(`/api/topologies/learn/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getTopologyPolicy(): Promise<TopologyLearningPolicy> {
  return request<TopologyLearningPolicy>('/api/topologies/policy');
}

export async function updateTopologyPolicy(
  body: TopologyLearningPolicyUpdate,
): Promise<TopologyLearningPolicy> {
  return request<TopologyLearningPolicy>('/api/topologies/policy', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}


// ---------------------------------------------------------------------------
// 访问关系标签 / 访问量趋势（V4）
// ---------------------------------------------------------------------------

export async function getEdgeTags(): Promise<{ tags: TopologyEdgeTag[] }> {
  return request<{ tags: TopologyEdgeTag[] }>('/api/topologies/edge-tags');
}

export async function createEdgeTag(input: TopologyEdgeTagInput): Promise<TopologyEdgeTag> {
  return request<TopologyEdgeTag>('/api/topologies/edge-tags', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteEdgeTag(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/topologies/edge-tags/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export interface AccessTrendsQuery {
  readonly windowHours: number;
  readonly bucket: 'hour' | 'day';
  readonly appSystemId?: string;
}

export async function getAccessTrends(query: AccessTrendsQuery): Promise<AccessTrendsResponse> {
  const params = new URLSearchParams({
    windowHours: String(query.windowHours),
    bucket: query.bucket,
  });
  if (query.appSystemId) params.set('appSystemId', query.appSystemId);
  return request<AccessTrendsResponse>(`/api/topologies/access-trends?${params.toString()}`);
}


export interface HttpRequestsQuery {
  readonly windowHours: number;
  readonly bucket: 'hour' | 'day';
  readonly appSystemId?: string;
}

export async function getHttpRequests(query: HttpRequestsQuery): Promise<HttpRequestTrendsResponse> {
  const params = new URLSearchParams({
    windowHours: String(query.windowHours),
    bucket: query.bucket,
  });
  if (query.appSystemId) params.set('appSystemId', query.appSystemId);
  return request<HttpRequestTrendsResponse>(`/api/topologies/http-requests?${params.toString()}`);
}

export async function suggestEdgeTags(body: {
  appSystemId?: string;
  relationKeys?: readonly string[];
}): Promise<EdgeTagSuggestResponse> {
  return request<EdgeTagSuggestResponse>('/api/topologies/edge-tags/suggest', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export type { EdgeTagSuggestion };


// ---------------------------------------------------------------------------
// 拓扑自然语言微调（视图/标签，不改原始图）
// ---------------------------------------------------------------------------

export async function adjustTopology(
  graphId: string,
  instruction: string,
): Promise<TopologyAdjustment & { clarification?: string }> {
  return request<TopologyAdjustment & { clarification?: string }>(
    `/api/topologies/${encodeURIComponent(graphId)}/adjust`,
    {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    },
  );
}

export async function getTopologyAdjustments(
  graphId: string,
): Promise<{ adjustments: TopologyAdjustment[] }> {
  return request<{ adjustments: TopologyAdjustment[] }>(
    `/api/topologies/${encodeURIComponent(graphId)}/adjustments`,
  );
}

export async function deleteTopologyAdjustment(
  graphId: string,
  adjustmentId: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/topologies/${encodeURIComponent(graphId)}/adjustments/${encodeURIComponent(adjustmentId)}`,
    { method: 'DELETE' },
  );
}

export type { TopologyAdjustment, TopologyAdjustOperation };
