import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJson, getCommandSigner } from '../agents/signing.js';
import { AgentCommandService } from '../agents/commands.js';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface ReleaseRecord {
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

export interface DeploymentRecord {
  readonly id: string;
  readonly releaseId: string;
  readonly environment: string;
  readonly strategy: string;
  readonly canaryPercent: number | null;
  readonly status: string;
  readonly reason: string | null;
  readonly preflight: Record<string, unknown> | null;
  readonly execution: Record<string, unknown> | null;
  readonly createdAt: string;
}

function releasePublicKey(): string {
  return process.env.OPSAGENT_RELEASE_PUBLIC_KEY ?? getCommandSigner().publicKey;
}

function verifyManifest(manifest: Record<string, unknown>, signature: string): boolean {
  try {
    const raw = Buffer.from(releasePublicKey(), 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(
      null,
      Buffer.from(canonicalJson(manifest), 'utf8'),
      key,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export class DeploymentService {
  constructor(private readonly pool: Pool) {}

  async createRelease(input: {
    tenantId: string;
    actorId: string;
    appSystemId?: string;
    version: string;
    artifactUrl: string;
    sha256: string;
    signature: string;
    deployCommand?: string;
    rollbackCommand?: string;
  }): Promise<ReleaseRecord | null> {
    const manifest: Record<string, unknown> = {
      appSystemId: input.appSystemId ?? null,
      version: input.version,
      artifactUrl: input.artifactUrl,
      sha256: input.sha256,
      ...(input.deployCommand ? { deployCommand: input.deployCommand } : {}),
      ...(input.rollbackCommand ? { rollbackCommand: input.rollbackCommand } : {}),
    };
    if (!verifyManifest(manifest, input.signature)) return null;
    if (input.appSystemId) {
      const owned = await this.pool.query(
        'SELECT 1 FROM app_systems WHERE id = $1 AND tenant_id = $2',
        [input.appSystemId, input.tenantId],
      );
      if (!owned.rows[0]) return null;
    }
    const result = await this.pool.query(
      `INSERT INTO releases
         (tenant_id, app_system_id, version, artifact_url, sha256, signature, status, deploy_command, rollback_command, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'verified', $7, $8, $9)
       ON CONFLICT (tenant_id, app_system_id, version) DO UPDATE
         SET artifact_url = EXCLUDED.artifact_url, sha256 = EXCLUDED.sha256, signature = EXCLUDED.signature,
             deploy_command = EXCLUDED.deploy_command, rollback_command = EXCLUDED.rollback_command
       RETURNING id, app_system_id, version, artifact_url, sha256, status, deploy_command, rollback_command, created_at`,
      [
        input.tenantId,
        input.appSystemId ?? null,
        input.version,
        input.artifactUrl,
        input.sha256,
        input.signature,
        input.deployCommand ?? null,
        input.rollbackCommand ?? null,
        input.actorId,
      ],
    );
    return result.rows[0] ? this.mapRelease(result.rows[0]) : null;
  }

  async listReleases(tenantId: string): Promise<ReleaseRecord[]> {
    const result = await this.pool.query(
      `SELECT id, app_system_id, version, artifact_url, sha256, status, deploy_command, rollback_command, created_at
       FROM releases WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.mapRelease(row));
  }

  async createDeployment(input: {
    tenantId: string;
    actorId: string;
    releaseId: string;
    environment: string;
    strategy: 'rolling' | 'canary';
    canaryPercent?: number;
  }): Promise<DeploymentRecord | null> {
    const release = await this.pool.query('SELECT 1 FROM releases WHERE id = $1 AND tenant_id = $2', [
      input.releaseId,
      input.tenantId,
    ]);
    if (!release.rows[0]) return null;
    const result = await this.pool.query(
      `INSERT INTO deployments
         (tenant_id, release_id, environment, strategy, canary_percent, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING id, release_id, environment, strategy, canary_percent, status, reason, preflight, execution, created_at`,
      [
        input.tenantId,
        input.releaseId,
        input.environment,
        input.strategy,
        input.strategy === 'canary' ? input.canaryPercent ?? 10 : null,
        input.actorId,
      ],
    );
    return result.rows[0] ? this.mapDeployment(result.rows[0]) : null;
  }

  async decideDeployment(input: {
    tenantId: string;
    actorId: string;
    deploymentId: string;
    decision: 'approve' | 'reject';
    reason?: string;
  }): Promise<DeploymentRecord | null> {
    const result = await this.pool.query(
      `UPDATE deployments
       SET status = $1, approved_by = $2, reason = $3, decided_at = now(),
           finished_at = CASE WHEN $1 = 'rejected' THEN now() ELSE finished_at END
       WHERE id = $4 AND tenant_id = $5 AND status = 'pending'
       RETURNING id, release_id, environment, strategy, canary_percent, status, reason, preflight, execution, created_at`,
      [input.decision === 'approve' ? 'approved' : 'rejected', input.actorId, input.reason ?? null, input.deploymentId, input.tenantId],
    );
    return result.rows[0] ? this.mapDeployment(result.rows[0]) : null;
  }

  async rollbackDeployment(input: {
    tenantId: string;
    deploymentId: string;
    reason: string;
  }): Promise<DeploymentRecord | null> {
    const current = await this.pool.query<{
      status: string;
      app_system_id: string | null;
      artifact_url: string;
      sha256: string;
      version: string;
      rollback_command: string | null;
    }>(
      `SELECT d.status, r.app_system_id, r.artifact_url, r.sha256, r.version, r.rollback_command
       FROM deployments d JOIN releases r ON r.id = d.release_id
       WHERE d.tenant_id = $1 AND d.id = $2`,
      [input.tenantId, input.deploymentId],
    );
    const row = current.rows[0];
    if (!row) return null;
    if (row.status !== 'deployed' || !row.app_system_id || !row.rollback_command) {
      const result = await this.pool.query(
        `UPDATE deployments
         SET status = 'rolled_back', reason = $1, finished_at = now()
         WHERE id = $2 AND tenant_id = $3 AND status IN ('approved', 'preflighted', 'canary', 'deploying')
         RETURNING id, release_id, environment, strategy, canary_percent, status, reason, preflight, execution, created_at`,
        [input.reason, input.deploymentId, input.tenantId],
      );
      return result.rows[0] ? this.mapDeployment(result.rows[0]) : null;
    }
    const agents = await this.pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE tenant_id = $1 AND app_system_id = $2
       AND status = 'online' AND last_seen > now() - interval '90 seconds'`,
      [input.tenantId, row.app_system_id],
    );
    if (agents.rows.length === 0) return null;
    const commands = new AgentCommandService(this.pool);
    const commandIds: string[] = [];
    for (const agent of agents.rows) {
      const command = await commands.create({
        tenantId: input.tenantId,
        agentId: agent.id,
        type: 'deployment_execute',
        input: {
          mode: 'rollback',
          artifactUrl: row.artifact_url,
          sha256: row.sha256,
          version: row.version,
          command: row.rollback_command,
        },
      });
      if (command) commandIds.push(command.id);
    }
    if (commandIds.length === 0) return null;
    await this.pool.query(
      `UPDATE deployments SET status = 'rolling_back', reason = $1, execution = $2::jsonb
       WHERE tenant_id = $3 AND id = $4`,
      [input.reason, JSON.stringify({ commandIds, mode: 'rollback', startedAt: new Date().toISOString() }), input.tenantId, input.deploymentId],
    );
    const results = await this.waitForCommands(commandIds);
    const ok = results.every((item) => item.status === 'completed' && (item.result as Record<string, unknown> | null)?.ok === true);
    await this.pool.query(
      `UPDATE deployments SET status = $1, execution = $2::jsonb, finished_at = now()
       WHERE tenant_id = $3 AND id = $4`,
      [
        ok ? 'rolled_back' : 'rollback_failed',
        JSON.stringify({ commandIds, mode: 'rollback', ok, results, finishedAt: new Date().toISOString() }),
        input.tenantId,
        input.deploymentId,
      ],
    );
    return this.getDeployment(input.tenantId, input.deploymentId);
  }

  async preflight(tenantId: string, id: string): Promise<DeploymentRecord | null> {
    const result = await this.pool.query<{
      artifact_url: string;
      sha256: string;
      version: string;
      status: string;
    }>(
      `SELECT r.artifact_url, r.sha256, r.version, d.status
       FROM deployments d JOIN releases r ON r.id = d.release_id
       WHERE d.tenant_id = $1 AND d.id = $2`,
      [tenantId, id],
    );
    const row = result.rows[0];
    if (!row || !['approved', 'pending'].includes(row.status)) return null;
    let preflight: Record<string, unknown>;
    let status = 'preflight_failed';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(row.artifact_url, { signal: controller.signal });
        if (!response.ok) throw new Error(`artifact returned ${response.status}`);
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (contentLength > 100 * 1024 * 1024) throw new Error('artifact is too large');
        const body = Buffer.from(await response.arrayBuffer());
        const actual = createHash('sha256').update(body).digest('hex');
        const ok = actual === row.sha256;
        preflight = { ok, expected: row.sha256, actual, bytes: body.length, checkedAt: new Date().toISOString() };
        if (ok) status = 'preflighted';
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      preflight = { ok: false, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    }
    await this.pool.query(
      `UPDATE deployments SET status = $1, preflight = $2::jsonb WHERE tenant_id = $3 AND id = $4`,
      [status, JSON.stringify(preflight), tenantId, id],
    );
    return this.getDeployment(tenantId, id);
  }

  async executeDeployment(tenantId: string, deploymentId: string): Promise<DeploymentRecord | null> {
    const result = await this.pool.query<{
      status: string;
      app_system_id: string | null;
      artifact_url: string;
      sha256: string;
      version: string;
      deploy_command: string | null;
    }>(
      `SELECT d.status, r.app_system_id, r.artifact_url, r.sha256, r.version, r.deploy_command
       FROM deployments d JOIN releases r ON r.id = d.release_id
       WHERE d.tenant_id = $1 AND d.id = $2`,
      [tenantId, deploymentId],
    );
    const row = result.rows[0];
    if (!row || !['approved', 'preflighted'].includes(row.status)) return null;
    if (!row.app_system_id || !row.deploy_command) return null;
    const agents = await this.pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE tenant_id = $1 AND app_system_id = $2
       AND status = 'online' AND last_seen > now() - interval '90 seconds'`,
      [tenantId, row.app_system_id],
    );
    if (agents.rows.length === 0) return null;
    const commands = new AgentCommandService(this.pool);
    const commandIds: string[] = [];
    for (const agent of agents.rows) {
      const command = await commands.create({
        tenantId,
        agentId: agent.id,
        type: 'deployment_execute',
        input: {
          mode: 'apply',
          artifactUrl: row.artifact_url,
          sha256: row.sha256,
          version: row.version,
          command: row.deploy_command,
        },
      });
      if (command) commandIds.push(command.id);
    }
    if (commandIds.length === 0) return null;
    await this.pool.query(
      `UPDATE deployments SET status = 'deploying', execution = $1::jsonb WHERE tenant_id = $2 AND id = $3`,
      [JSON.stringify({ commandIds, mode: 'apply', startedAt: new Date().toISOString() }), tenantId, deploymentId],
    );
    const results = await this.waitForCommands(commandIds);
    const ok = results.every((item) => item.status === 'completed' && (item.result as Record<string, unknown> | null)?.ok === true);
    await this.pool.query(
      `UPDATE deployments SET status = $1, execution = $2::jsonb, finished_at = now()
       WHERE tenant_id = $3 AND id = $4`,
      [
        ok ? 'deployed' : 'failed',
        JSON.stringify({ commandIds, mode: 'apply', ok, results, finishedAt: new Date().toISOString() }),
        tenantId,
        deploymentId,
      ],
    );
    return this.getDeployment(tenantId, deploymentId);
  }

  private async waitForCommands(ids: string[]): Promise<Array<{ id: string; status: string; result: unknown }>> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await this.pool.query<{ id: string; status: string; result: unknown }>(
        'SELECT id, status, result FROM agent_commands WHERE id = ANY($1::uuid[])',
        [ids],
      );
      const done = result.rows.length === ids.length && result.rows.every((row) => ['completed', 'failed'].includes(row.status));
      if (done) return result.rows;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const result = await this.pool.query<{ id: string; status: string; result: unknown }>(
      'SELECT id, status, result FROM agent_commands WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return result.rows;
  }

  async getDeployment(tenantId: string, id: string): Promise<DeploymentRecord | null> {
    const result = await this.pool.query(
      `SELECT id, release_id, environment, strategy, canary_percent, status, reason, preflight, created_at
       FROM deployments WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ? this.mapDeployment(result.rows[0]) : null;
  }

  async listDeployments(tenantId: string): Promise<DeploymentRecord[]> {
    const result = await this.pool.query(
      `SELECT id, release_id, environment, strategy, canary_percent, status, reason, preflight, created_at
       FROM deployments WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.mapDeployment(row));
  }

  private mapRelease(row: {
    id: string;
    app_system_id: string | null;
    version: string;
    artifact_url: string;
    sha256: string;
    status: string;
    deploy_command: string | null;
    rollback_command: string | null;
    created_at: Date;
  }): ReleaseRecord {
    return {
      id: row.id,
      appSystemId: row.app_system_id,
      version: row.version,
      artifactUrl: row.artifact_url,
      sha256: row.sha256,
      status: row.status,
      deployCommand: row.deploy_command,
      rollbackCommand: row.rollback_command,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapDeployment(row: {
    id: string;
    release_id: string;
    environment: string;
    strategy: string;
    canary_percent: number | null;
    status: string;
    reason: string | null;
    preflight: Record<string, unknown> | null;
    execution: Record<string, unknown> | null;
    created_at: Date;
  }): DeploymentRecord {
    return {
      id: row.id,
      releaseId: row.release_id,
      environment: row.environment,
      strategy: row.strategy,
      canaryPercent: row.canary_percent,
      status: row.status,
      reason: row.reason,
      preflight: row.preflight,
      execution: row.execution,
      createdAt: row.created_at.toISOString(),
    };
  }
}
