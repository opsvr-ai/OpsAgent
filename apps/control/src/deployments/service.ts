import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJson, getCommandSigner } from '../agents/signing.js';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface ReleaseRecord {
  readonly id: string;
  readonly appSystemId: string | null;
  readonly version: string;
  readonly artifactUrl: string;
  readonly sha256: string;
  readonly status: string;
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
  }): Promise<ReleaseRecord | null> {
    const manifest: Record<string, unknown> = {
      appSystemId: input.appSystemId ?? null,
      version: input.version,
      artifactUrl: input.artifactUrl,
      sha256: input.sha256,
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
         (tenant_id, app_system_id, version, artifact_url, sha256, signature, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'verified', $7)
       ON CONFLICT (tenant_id, app_system_id, version) DO UPDATE
         SET artifact_url = EXCLUDED.artifact_url, sha256 = EXCLUDED.sha256, signature = EXCLUDED.signature
       RETURNING id, app_system_id, version, artifact_url, sha256, status, created_at`,
      [
        input.tenantId,
        input.appSystemId ?? null,
        input.version,
        input.artifactUrl,
        input.sha256,
        input.signature,
        input.actorId,
      ],
    );
    return result.rows[0] ? this.mapRelease(result.rows[0]) : null;
  }

  async listReleases(tenantId: string): Promise<ReleaseRecord[]> {
    const result = await this.pool.query(
      `SELECT id, app_system_id, version, artifact_url, sha256, status, created_at
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
       RETURNING id, release_id, environment, strategy, canary_percent, status, reason, preflight, created_at`,
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
       RETURNING id, release_id, environment, strategy, canary_percent, status, reason, preflight, created_at`,
      [input.decision === 'approve' ? 'approved' : 'rejected', input.actorId, input.reason ?? null, input.deploymentId, input.tenantId],
    );
    return result.rows[0] ? this.mapDeployment(result.rows[0]) : null;
  }

  async rollbackDeployment(input: {
    tenantId: string;
    deploymentId: string;
    reason: string;
  }): Promise<DeploymentRecord | null> {
    const result = await this.pool.query(
      `UPDATE deployments
       SET status = 'rolled_back', reason = $1, finished_at = now()
       WHERE id = $2 AND tenant_id = $3 AND status IN ('approved', 'canary', 'deploying')
       RETURNING id, release_id, environment, strategy, canary_percent, status, reason, preflight, created_at`,
      [input.reason, input.deploymentId, input.tenantId],
    );
    return result.rows[0] ? this.mapDeployment(result.rows[0]) : null;
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
    created_at: Date;
  }): ReleaseRecord {
    return {
      id: row.id,
      appSystemId: row.app_system_id,
      version: row.version,
      artifactUrl: row.artifact_url,
      sha256: row.sha256,
      status: row.status,
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
      createdAt: row.created_at.toISOString(),
    };
  }
}
