import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const TOOLS = (process.env.OPSAGENT_APPROVAL_TOOLS ?? 'write,edit,bash,pwsh,shell')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function log(message) {
  try {
    appendFileSync(process.env.OPSAGENT_APPROVAL_LOG ?? '/tmp/opsagent-approval.log', `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Debug logging must never affect the approval path.
  }
}

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
  log(`created ${tool} ${callId} -> ${body.id}`);
  return body.id;
}

async function waitForDecision(id, signal) {
  const deadline = Date.now() + Number(process.env.OPS_APPROVAL_TIMEOUT_MS ?? 900_000);
  for (;;) {
    if (signal?.aborted) return 'cancelled';
    if (Date.now() > deadline) return 'cancelled';
    const response = await fetch(`${CONTROL_URL}/internal/approvals/${id}`, {
      headers: headers(),
      signal,
    });
    if (!response.ok) throw new Error(`approval_poll_failed:${response.status}`);
    const body = await response.json();
    if (body.status === 'approved') {
      log(`approved ${id}`);
      return 'allowed-once';
    }
    if (body.status === 'rejected') {
      log(`rejected ${id}`);
      return 'rejected';
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const name = 'ops-approval-bridge';
export const inject = [];

log('module loaded');

export function apply(ctx) {
  log('plugin applied');
  ctx.on('tools/pre-execute', async (exec, next) => {
    log(`pre-execute ${exec.name}`);
    if (!TOOLS.includes(exec.name)) return next();
    const callId = exec.callId ?? randomUUID();
    try {
      const id = await createApproval(exec.name, callId, `OpsAgent approval required for ${exec.name}`, exec.arguments ?? exec.input ?? {});
      const outcome = await waitForDecision(id, exec.signal);
      log(`outcome ${id} ${outcome}`);
      if (outcome === 'allowed-once') return { kind: 'allow' };
      return { kind: 'deny', reason: outcome === 'rejected' ? `the user rejected tool "${exec.name}"` : `approval for tool "${exec.name}" was cancelled` };
    } catch (error) {
      log(`error ${error instanceof Error ? error.message : String(error)}`);
      return { kind: 'deny', reason: `approval unavailable for tool "${exec.name}"` };
    }
  });
}
