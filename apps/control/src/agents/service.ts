import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface AppSystemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly owner: string | null;
  readonly criticality: string;
  readonly agentCount: number;
  readonly onlineCount: number;
}

export interface AgentRecord {
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
  readonly applications: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly agentInfo: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly discoveryAt: string | null;
  readonly commandKeyId: string | null;
  readonly tlsCertExpiresAt: string | null;
  readonly tlsCertSerial: string | null;
  readonly appSystem: AppSystemSummary | null;
}

export interface DiscoveryPayload {
  readonly system?: unknown;
  readonly applications?: unknown;
  readonly agent?: unknown;
  readonly discoveredAt?: unknown;
}

export interface AgentFleetQuery {
  readonly query?: string;
  readonly status?: string;
  readonly appSystemId?: string;
  readonly os?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface AgentFleetSummary {
  readonly total: number;
  readonly online: number;
  readonly offline: number;
  readonly appSystems: number;
  readonly applications: number;
  readonly discovered: number;
}

export interface AgentFleetResult {
  readonly items: AgentRecord[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly summary: AgentFleetSummary;
  readonly appSystems: AppSystemSummary[];
}

interface AgentRow {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  version: string;
  status: string;
  last_seen: Date;
  metrics: Record<string, unknown> | null;
  system_info: Record<string, unknown> | null;
  applications: Array<Record<string, unknown>> | null;
  agent_info: Record<string, unknown> | null;
  tags: string[] | null;
  discovery_at: Date | null;
  command_key_id: string | null;
  tls_cert_expires_at: Date | null;
  tls_cert_serial: string | null;
  app_system_id: string | null;
  app_system_code: string | null;
  app_system_name: string | null;
  app_system_owner: string | null;
  app_system_criticality: string | null;
}

const AGENT_SELECT = `SELECT a.id, a.name, a.hostname, a.os, a.arch, a.version,
  CASE WHEN a.last_seen < now() - interval '90 seconds' THEN 'offline' ELSE a.status END AS status,
  a.last_seen, a.metrics, a.system_info, a.applications, a.agent_info, a.tags, a.discovery_at,
  a.command_key_id, a.tls_cert_expires_at, a.tls_cert_serial,
  a.app_system_id, s.code AS app_system_code, s.name AS app_system_name,
  s.owner AS app_system_owner, s.criticality AS app_system_criticality
  FROM agents a LEFT JOIN app_systems s ON s.id = a.app_system_id`;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function applicationList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null && !Array.isArray(item));
}

function tagList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export class AgentService {
  constructor(private readonly pool: Pool) {}

  async register(input: {
    tenantId: string;
    name: string;
    hostname: string;
    os: string;
    arch: string;
    version: string;
    capabilities: readonly string[];
    resultPublicKey?: string;
    discovery?: DiscoveryPayload;
  }): Promise<{ agent: AgentRecord; agentKey: string }> {
    const agentKey = randomUUID();
    const discovery = input.discovery ?? {};
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO agents
         (tenant_id, name, hostname, os, arch, version, status, capabilities, agent_key, last_seen,
          result_public_key, system_info, applications, agent_info, discovery_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'online', $7::jsonb, $8, now(),
               $9, $10::jsonb, $11::jsonb, $12::jsonb, now())
       ON CONFLICT (tenant_id, hostname) DO UPDATE SET
         name = EXCLUDED.name,
         os = EXCLUDED.os,
         arch = EXCLUDED.arch,
         version = EXCLUDED.version,
         status = 'online',
         capabilities = EXCLUDED.capabilities,
         agent_key = EXCLUDED.agent_key,
         last_seen = now(),
         result_public_key = COALESCE(EXCLUDED.result_public_key, agents.result_public_key),
         system_info = EXCLUDED.system_info,
         applications = EXCLUDED.applications,
         agent_info = EXCLUDED.agent_info,
         discovery_at = now()
       RETURNING id`,
      [
        input.tenantId,
        input.name,
        input.hostname,
        input.os,
        input.arch,
        input.version,
        JSON.stringify(input.capabilities),
        agentKey,
        input.resultPublicKey ?? null,
        JSON.stringify(record(discovery.system)),
        JSON.stringify(applicationList(discovery.applications)),
        JSON.stringify(record(discovery.agent)),
      ],
    );
    const agentId = result.rows[0]?.id;
    if (!agentId) throw new Error('failed to register agent');
    const agent = await this.get(agentId, input.tenantId);
    if (!agent) throw new Error('failed to load registered agent');
    return { agent, agentKey };
  }

  async heartbeat(
    id: string,
    key: string,
    metrics?: Readonly<Record<string, unknown>>,
    discovery?: DiscoveryPayload,
    commandKeyId?: string,
    tlsCertExpiresAt?: string,
    tlsCertSerial?: string,
  ): Promise<AgentRecord | null> {
    const system = discovery ? record(discovery.system) : null;
    const applications = discovery ? applicationList(discovery.applications) : null;
    const agentInfo = discovery ? record(discovery.agent) : null;
    const previous = await this.pool.query<{ command_key_id: string | null }>(
      'SELECT command_key_id FROM agents WHERE id = $1 AND agent_key = $2',
      [id, key],
    );
    const previousKeyId = previous.rows[0]?.command_key_id ?? null;
    const result = await this.pool.query<{ tenant_id: string }>(
      `UPDATE agents
       SET last_seen = now(), status = 'online',
           metrics = COALESCE($3::jsonb, metrics),
           system_info = COALESCE($4::jsonb, system_info),
           applications = COALESCE($5::jsonb, applications),
           agent_info = COALESCE($6::jsonb, agent_info),
           command_key_id = COALESCE($7, command_key_id),
           tls_cert_expires_at = COALESCE($8::timestamptz, tls_cert_expires_at),
           tls_cert_serial = COALESCE($9, tls_cert_serial),
           discovery_at = CASE WHEN $4::jsonb IS NULL THEN discovery_at ELSE now() END
       WHERE id = $1 AND agent_key = $2
       RETURNING tenant_id`,
      [
        id,
        key,
        metrics ? JSON.stringify(metrics) : null,
        system ? JSON.stringify(system) : null,
        applications ? JSON.stringify(applications) : null,
        agentInfo ? JSON.stringify(agentInfo) : null,
        commandKeyId ?? null,
        tlsCertExpiresAt ?? null,
        tlsCertSerial ?? null,
      ],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (tenantId && commandKeyId && commandKeyId !== previousKeyId) {
      await this.pool.query(
        `INSERT INTO agent_command_key_history (tenant_id, agent_id, previous_key_id, key_id)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, id, previousKeyId, commandKeyId],
      );
    }
    return tenantId ? this.get(id, tenantId) : null;
  }

  async keyHistory(tenantId: string, agentId: string): Promise<Array<{
    id: string;
    previousKeyId: string | null;
    keyId: string;
    changedAt: string;
  }>> {
    const result = await this.pool.query<{
      id: string;
      previous_key_id: string | null;
      key_id: string;
      changed_at: Date;
    }>(
      `SELECT id, previous_key_id, key_id, changed_at FROM agent_command_key_history
       WHERE tenant_id = $1 AND agent_id = $2 ORDER BY changed_at DESC LIMIT 50`,
      [tenantId, agentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      previousKeyId: row.previous_key_id,
      keyId: row.key_id,
      changedAt: row.changed_at.toISOString(),
    }));
  }

  async list(tenantId: string): Promise<AgentRecord[]> {
    const result = await this.pool.query<AgentRow>(
      `${AGENT_SELECT} WHERE a.tenant_id = $1 ORDER BY a.last_seen DESC`,
      [tenantId],
    );
    return result.rows.map((row) => this.map(row));
  }

  async get(agentId: string, tenantId: string): Promise<AgentRecord | null> {
    const result = await this.pool.query<AgentRow>(
      `${AGENT_SELECT} WHERE a.id = $1 AND a.tenant_id = $2`,
      [agentId, tenantId],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async findByMention(tenantId: string, text: string): Promise<AgentRecord | null> {
    const result = await this.pool.query<AgentRow>(
      `${AGENT_SELECT}
       WHERE a.tenant_id = $1
         AND (position(lower(a.hostname) in lower($2)) > 0 OR position(lower(a.name) in lower($2)) > 0)
       ORDER BY length(a.hostname) DESC
       LIMIT 1`,
      [tenantId, text],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async findByIp(tenantId: string, ip: string): Promise<AgentRecord | null> {
    const result = await this.pool.query<AgentRow>(
      `${AGENT_SELECT}
       WHERE a.tenant_id = $1
         AND (a.system_info->>'ip' = $2 OR a.system_info->'ipAddresses' ? $2)
       ORDER BY a.last_seen DESC NULLS LAST
       LIMIT 1`,
      [tenantId, ip],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async fleet(tenantId: string, query: AgentFleetQuery = {}): Promise<AgentFleetResult> {    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 20)));
    const search = (query.query ?? '').trim();
    const status = query.status ?? '';
    const appSystemId = query.appSystemId ?? '';
    const os = query.os ?? '';
    const values: unknown[] = [tenantId];
    const filters: string[] = ['a.tenant_id = $1'];
    if (search) {
      values.push(`%${search}%`);
      const position = values.length;
      filters.push(`(
        a.hostname ILIKE $${position} OR a.name ILIKE $${position}
        OR a.os ILIKE $${position} OR a.arch ILIKE $${position}
        OR COALESCE(a.system_info->>'ip', '') ILIKE $${position}
        OR COALESCE(a.system_info->>'osName', '') ILIKE $${position}
        OR COALESCE(s.name, '') ILIKE $${position}
      )`);
    }
    if (status === 'online') filters.push(`a.last_seen >= now() - interval '90 seconds' AND a.status = 'online'`);
    if (status === 'offline') filters.push(`(a.last_seen < now() - interval '90 seconds' OR a.status <> 'online')`);
    if (os) {
      values.push(os);
      filters.push(`a.os = $${values.length}`);
    }
    if (appSystemId) {
      values.push(appSystemId);
      filters.push(`a.app_system_id = $${values.length}`);
    }
    const where = filters.join(' AND ');

    const totalResult = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM agents a LEFT JOIN app_systems s ON s.id = a.app_system_id WHERE ${where}`,
      values,
    );
    const pagedValues = [...values, pageSize, (page - 1) * pageSize];
    const items = await this.pool.query<AgentRow>(
      `${AGENT_SELECT} WHERE ${where}
       ORDER BY (a.last_seen >= now() - interval '90 seconds' AND a.status = 'online') DESC, a.last_seen DESC
       LIMIT $${pagedValues.length - 1} OFFSET $${pagedValues.length}`,
      pagedValues,
    );
    const summary = await this.pool.query<{
      total: string; online: string; offline: string; app_systems: string; applications: string; discovered: string;
    }>(
      `SELECT count(*)::text AS total,
         count(*) FILTER (WHERE last_seen >= now() - interval '90 seconds' AND status = 'online')::text AS online,
         count(*) FILTER (WHERE last_seen < now() - interval '90 seconds' OR status <> 'online')::text AS offline,
         count(DISTINCT app_system_id)::text AS app_systems,
         COALESCE(sum(jsonb_array_length(applications)), 0)::text AS applications,
         count(*) FILTER (WHERE discovery_at IS NOT NULL)::text AS discovered
       FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    const summaryRow = summary.rows[0];
    return {
      items: items.rows.map((row) => this.map(row)),
      total: Number.parseInt(totalResult.rows[0]?.total ?? '0', 10),
      page,
      pageSize,
      summary: {
        total: Number.parseInt(summaryRow?.total ?? '0', 10),
        online: Number.parseInt(summaryRow?.online ?? '0', 10),
        offline: Number.parseInt(summaryRow?.offline ?? '0', 10),
        appSystems: Number.parseInt(summaryRow?.app_systems ?? '0', 10),
        applications: Number.parseInt(summaryRow?.applications ?? '0', 10),
        discovered: Number.parseInt(summaryRow?.discovered ?? '0', 10),
      },
      appSystems: await this.listAppSystems(tenantId),
    };
  }

  async listAppSystems(tenantId: string): Promise<AppSystemSummary[]> {
    const result = await this.pool.query<{
      id: string; code: string; name: string; owner: string | null; criticality: string;
      agent_count: string; online_count: string;
    }>(
      `SELECT s.id, s.code, s.name, s.owner, s.criticality,
         count(a.id)::text AS agent_count,
         count(a.id) FILTER (WHERE a.last_seen >= now() - interval '90 seconds' AND a.status = 'online')::text AS online_count
       FROM app_systems s LEFT JOIN agents a ON a.app_system_id = s.id AND a.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1
       GROUP BY s.id, s.code, s.name, s.owner, s.criticality
       ORDER BY s.criticality, s.name`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      owner: row.owner,
      criticality: row.criticality,
      agentCount: Number.parseInt(row.agent_count, 10),
      onlineCount: Number.parseInt(row.online_count, 10),
    }));
  }

  async assignAppSystem(tenantId: string, agentId: string, appSystemId: string | null): Promise<AgentRecord | null> {
    if (appSystemId) {
      const owned = await this.pool.query('SELECT 1 FROM app_systems WHERE id = $1 AND tenant_id = $2', [appSystemId, tenantId]);
      if (!owned.rows[0]) return null;
    }
    await this.pool.query(
      'UPDATE agents SET app_system_id = $3 WHERE id = $1 AND tenant_id = $2',
      [agentId, tenantId, appSystemId],
    );
    return this.get(agentId, tenantId);
  }

  private map(row: AgentRow): AgentRecord {
    return {
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      os: row.os,
      arch: row.arch,
      version: row.version,
      status: row.status,
      lastSeen: row.last_seen.toISOString(),
      metrics: row.metrics ?? {},
      systemInfo: row.system_info ?? {},
      applications: row.applications ?? [],
      agentInfo: row.agent_info ?? {},
      tags: tagList(row.tags),
      discoveryAt: row.discovery_at ? row.discovery_at.toISOString() : null,
      commandKeyId: row.command_key_id ?? null,
      tlsCertExpiresAt: row.tls_cert_expires_at ? row.tls_cert_expires_at.toISOString() : null,
      tlsCertSerial: row.tls_cert_serial ?? null,
      appSystem: row.app_system_id && row.app_system_code && row.app_system_name
        ? {
            id: row.app_system_id,
            code: row.app_system_code,
            name: row.app_system_name,
            owner: row.app_system_owner,
            criticality: row.app_system_criticality ?? 'P2',
            agentCount: 0,
            onlineCount: 0,
          }
        : null,
    };
  }
}
