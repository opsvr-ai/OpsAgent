import type { Pool } from 'pg';

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

interface PolicyRow {
  id: string;
  deployment_id: string;
  host: string;
  stable_upstream: string;
  canary_upstream: string;
  canary_weight: number;
  status: string;
  updated_at: Date;
}

const UPSTREAM = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const HOST = /^[A-Za-z0-9.*-]+$/;

function map(row: PolicyRow): TrafficCanaryPolicy {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    host: row.host,
    stableUpstream: row.stable_upstream,
    canaryUpstream: row.canary_upstream,
    canaryWeight: row.canary_weight,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function renderNginxCanaryConfig(policy: Pick<TrafficCanaryPolicy, 'host' | 'stableUpstream' | 'canaryUpstream' | 'canaryWeight'>): string {
  const stable = policy.stableUpstream;
  const canary = policy.canaryUpstream;
  const weight = Math.min(Math.max(Math.trunc(policy.canaryWeight), 0), 100);
  return [
    `upstream ${policy.host}_stable { server ${stable}; }`,
    `upstream ${policy.host}_canary { server ${canary}; }`,
    '',
    `split_clients "\${remote_addr}\${request_id}" $${policy.host}_backend {`,
    `    ${weight}% ${policy.host}_canary;`,
    `    * ${policy.host}_stable;`,
    '}',
    '',
    'server {',
    `    server_name ${policy.host};`,
    '    location / {',
    `        proxy_pass http://$${policy.host}_backend;`,
    '        proxy_set_header Host $host;',
    '    }',
    '}',
    '',
  ].join('\n');
}

export class TrafficCanaryService {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string, deploymentId: string): Promise<TrafficCanaryPolicy | null> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT id, deployment_id, host, stable_upstream, canary_upstream, canary_weight, status, updated_at
       FROM traffic_canary_policies WHERE tenant_id = $1 AND deployment_id = $2`,
      [tenantId, deploymentId],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async upsert(
    tenantId: string,
    deploymentId: string,
    input: {
      host: string;
      stableUpstream: string;
      canaryUpstream: string;
      canaryWeight: number;
    },
  ): Promise<TrafficCanaryPolicy | null> {
    if (!HOST.test(input.host) || !UPSTREAM.test(input.stableUpstream) || !UPSTREAM.test(input.canaryUpstream)) {
      return null;
    }
    const deployment = await this.pool.query<{ status: string }>(
      `SELECT status FROM deployments WHERE id = $1 AND tenant_id = $2`,
      [deploymentId, tenantId],
    );
    if (!deployment.rows[0] || !['canary', 'deployed', 'preflighted', 'approved'].includes(deployment.rows[0].status)) {
      return null;
    }
    const result = await this.pool.query<PolicyRow>(
      `INSERT INTO traffic_canary_policies
         (tenant_id, deployment_id, host, stable_upstream, canary_upstream, canary_weight, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (tenant_id, deployment_id) DO UPDATE
       SET host = EXCLUDED.host, stable_upstream = EXCLUDED.stable_upstream,
           canary_upstream = EXCLUDED.canary_upstream, canary_weight = EXCLUDED.canary_weight,
           status = 'active', updated_at = now()
       RETURNING id, deployment_id, host, stable_upstream, canary_upstream, canary_weight, status, updated_at`,
      [
        tenantId,
        deploymentId,
        input.host,
        input.stableUpstream,
        input.canaryUpstream,
        Math.min(Math.max(Math.trunc(input.canaryWeight), 0), 100),
      ],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async setWeight(tenantId: string, deploymentId: string, weight: number): Promise<TrafficCanaryPolicy | null> {
    const result = await this.pool.query<PolicyRow>(
      `UPDATE traffic_canary_policies
       SET canary_weight = $3, status = $4, updated_at = now()
       WHERE tenant_id = $1 AND deployment_id = $2
       RETURNING id, deployment_id, host, stable_upstream, canary_upstream, canary_weight, status, updated_at`,
      [
        tenantId,
        deploymentId,
        Math.min(Math.max(Math.trunc(weight), 0), 100),
        weight >= 100 ? 'promoted' : weight <= 0 ? 'rolled_back' : 'active',
      ],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
}
