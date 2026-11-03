const TOOLS = (process.env.OPSAGENT_APPROVAL_TOOLS ?? 'write,edit,bash,pwsh,shell')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const callDetails = new Map();

const CONTROL_URL = process.env.OPSAGENT_CONTROL_URL ?? 'http://127.0.0.1:8080';
const TENANT_ID = process.env.OPSAGENT_TENANT_ID ?? '';
const SESSION_ID = process.env.OPSAGENT_SESSION_ID ?? '';
const TOKEN = process.env.OPSAGENT_INTERNAL_TOKEN ?? '';

function headers() {
  return {
    'content-type': 'application/json',
    ...(TOKEN ? { 'x-opsagent-token': TOKEN } : {}),
  };
}

async function createApproval(tool, callId, reason, details) {
  const response = await fetch(`${CONTROL_URL}/internal/approvals`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      tenantId: TENANT_ID,
      runtimeSessionId: SESSION_ID,
      tool,
      callId,
      reason,
      details: details ?? {},
    }),
  });
  if (!response.ok) throw new Error(`approval_create_failed:${response.status}`);
  const body = await response.json();
  return body.id;
}

async function waitForDecision(id, signal) {
  for (;;) {
    if (signal?.aborted) return 'cancelled';
    const response = await fetch(`${CONTROL_URL}/internal/approvals/${id}`, {
      headers: headers(),
      signal,
    });
    if (!response.ok) throw new Error(`approval_poll_failed:${response.status}`);
    const body = await response.json();
    if (body.status === 'approved') return 'allowed-once';
    if (body.status === 'rejected') return 'rejected';
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const name = 'ops-approval-bridge';
export const inject = ['approval'];

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!TOOLS.includes(exec.name)) return next();
    const callId = exec.callId ?? exec.id ?? '';
    if (callId) callDetails.set(callId, exec.input ?? {});
    return { kind: 'ask', reason: `OpsAgent approval required for ${exec.name}` };
  });

  ctx.on('approval/request', async (req) => {
    try {
      const details = callDetails.get(req.callId) ?? {};
      callDetails.delete(req.callId);
      const id = await createApproval(req.toolName, req.callId, req.reason, details);
      return await waitForDecision(id, req.signal);
    } catch (error) {
      console.error(`ops-approval-bridge: ${error instanceof Error ? error.message : error}`);
      return 'unavailable';
    }
  });
}
