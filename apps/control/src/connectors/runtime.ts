import type { Pool } from 'pg';
import type { ConnectorRecord } from './service.js';
import type { Connector, ConnectorTool } from './types.js';
import { createAlertmanagerConnector } from './alertmanager.js';
import { createClickHouseConnector } from './clickhouse.js';
import { createGrafanaConnector } from './grafana.js';
import { createHttpConnector } from './http.js';
import { createPrometheusConnector } from './prometheus.js';
import { createZabbixConnector } from './zabbix.js';
import { createPostgresConnector } from './postgres.js';
import { createMysqlConnector } from './mysql.js';
import { createRedisConnector } from './redis.js';
import { createSshConnector } from './ssh.js';
import {
  createMysqlQuery,
  createPostgresQuery,
  createRedisClient,
  createSshExec,
} from './drivers.js';

function baseUrl(record: ConnectorRecord): string {
  const value = record.config.baseUrl;
  if (typeof value !== 'string') throw new Error(`connector ${record.name} requires baseUrl`);
  return value;
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

function buildConnector(record: ConnectorRecord): Connector | null {
  if (record.connectorType === 'postgres') {
    const dsn = record.config.connectionString;
    if (typeof dsn !== 'string') return null;
    return createPostgresConnector({ query: createPostgresQuery(dsn) });
  }
  if (record.connectorType === 'mysql') {
    const url = record.config.url;
    if (typeof url !== 'string') return null;
    return createMysqlConnector({ query: createMysqlQuery(url) });
  }
  if (record.connectorType === 'redis') {
    const url = record.config.url;
    if (typeof url !== 'string') return null;
    return createRedisConnector({ client: createRedisClient(url) });
  }
  if (record.connectorType === 'ssh') {
    const host = record.config.host;
    const username = record.config.username;
    if (typeof host !== 'string' || typeof username !== 'string') return null;
    return createSshConnector({
      exec: createSshExec({
        host,
        username,
        ...(typeof record.config.port === 'number' ? { port: record.config.port } : {}),
        ...(typeof record.config.password === 'string'
          ? { password: record.config.password }
          : {}),
        ...(typeof record.config.privateKey === 'string'
          ? { privateKey: record.config.privateKey }
          : {}),
      }),
    });
  }

  const url = baseUrl(record);
  const allowHosts = [hostOf(url)];
  switch (record.connectorType) {
    case 'prometheus':
      return createPrometheusConnector({ baseUrl: url, allowHosts });
    case 'grafana':
      return createGrafanaConnector({ baseUrl: url, allowHosts });
    case 'alertmanager':
      return createAlertmanagerConnector({ baseUrl: url, allowHosts });
    case 'clickhouse':
      return createClickHouseConnector({
        baseUrl: url,
        allowHosts,
        database: typeof record.config.database === 'string' ? record.config.database : 'default',
      });
    case 'http':
      return createHttpConnector({ baseUrl: url, allowHosts });
    case 'zabbix': {
      const username = record.config.username;
      const password = record.config.password;
      if (typeof username !== 'string' || typeof password !== 'string') return null;
      return createZabbixConnector({ baseUrl: url, allowHosts, username, password });
    }
    default:
      return null;
  }
}

export class ConnectorToolResolver {
  private readonly cache = new Map<string, Map<string, ConnectorTool>>();

  constructor(private readonly pool: Pool) {}

  async resolve(tenantId: string, name: string): Promise<ConnectorTool | undefined> {
    let tools = this.cache.get(tenantId);
    if (!tools) {
      tools = await this.load(tenantId);
      this.cache.set(tenantId, tools);
    }
    return tools.get(name);
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async load(tenantId: string): Promise<Map<string, ConnectorTool>> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, connector_type, name, config, credential_ref, status
       FROM connectors WHERE tenant_id = $1 AND status <> 'archived'`,
      [tenantId],
    );
    const tools = new Map<string, ConnectorTool>();
    for (const row of result.rows as Array<{
      id: string;
      tenant_id: string;
      connector_type: string;
      name: string;
      config: Record<string, unknown>;
      credential_ref: string | null;
      status: string;
    }>) {
      const record: ConnectorRecord = {
        id: row.id,
        tenantId: row.tenant_id,
        connectorType: row.connector_type,
        name: row.name,
        config: row.config,
        credentialRef: row.credential_ref,
        status: row.status,
      };
      try {
        const connector = buildConnector(record);
        for (const tool of connector?.tools ?? []) tools.set(tool.name, tool);
      } catch {
        // A broken connector must not prevent other tools from loading.
      }
    }
    return tools;
  }
}
