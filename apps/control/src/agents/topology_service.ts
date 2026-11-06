import type { Pool } from 'pg';

export interface AccessTopologyService {
  name: string;
  ports: number[];
}

export interface AccessTopologyNode {
  hostname: string;
  appSystemId: string | null;
  appSystemName: string;
  status: string;
  ip: string;
  anomalies: string[];
  services: AccessTopologyService[];
}

export interface AccessTopologyEdge {
  fromHost: string;
  fromService: string;
  toHost: string;
  toService: string;
  toPort: number;
  count: number;
  protocol: string;
  targetAppSystemId: string | null;
  targetAppSystemName: string;
}

export interface AccessTopology {
  system: { id: string; name: string; code: string };
  nodes: AccessTopologyNode[];
  edges: AccessTopologyEdge[];
  externalSystems: Array<{
    appSystemId: string;
    appSystemName: string;
    edges: AccessTopologyEdge[];
  }>;
}

type AgentRow = {
  id: string;
  hostname: string;
  app_system_id: string | null;
  app_system_name: string | null;
  app_system_code: string | null;
  status: string;
  system_info: Record<string, unknown>;
};

type InventoryRow = {
  agent_id: string;
  kind: string;
  name: string;
  detail: Record<string, unknown>;
};

type ConnectionRow = {
  agent_id: string;
  local_port: number;
  remote_address: string;
  remote_port: number;
  process: string;
  count: string;
};

function normalizeProcess(value: string): string {
  const quoted = value.match(/"([^"]+)"/)?.[1];
  const raw = (quoted ?? value).trim();
  const base = raw.split('/').pop() ?? raw;
  return base.replace(/^\[|\]$/g, '').slice(0, 80);
}

function jarService(command: string): string {
  const match = command.match(/-jar\s+([^\s]+)/);
  if (!match) return '';
  const file = (match[1] ?? '').split('/').pop() ?? '';
  return file.replace(/\.jar$/i, '').slice(0, 80);
}

export class AppSystemTopologyService {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string, appSystemId: string): Promise<AccessTopology | null> {
    const system = await this.pool.query<{ id: string; name: string; code: string }>(
      'SELECT id, name, code FROM app_systems WHERE tenant_id = $1 AND id = $2',
      [tenantId, appSystemId],
    );
    if (!system.rows[0]) return null;
    const agents = await this.pool.query<AgentRow>(
      `SELECT a.id, a.hostname, a.app_system_id, s.name AS app_system_name, s.code AS app_system_code,
              a.status, a.system_info
       FROM agents a LEFT JOIN app_systems s ON s.id = a.app_system_id
       WHERE a.tenant_id = $1`,
      [tenantId],
    );
    const inventory = await this.pool.query<InventoryRow>(
      `SELECT i.agent_id, i.kind, i.name, i.detail
       FROM agent_inventory i JOIN agents a ON a.id = i.agent_id
       WHERE i.tenant_id = $1 AND a.tenant_id = $1 AND i.kind IN ('process', 'port')`,
      [tenantId],
    );
    const sourceIds = agents.rows.filter((agent) => agent.app_system_id === appSystemId).map((agent) => agent.id);
    const events: Array<{ agent_id: string; title: string; severity: string }> = sourceIds.length === 0 ? [] : (await this.pool.query<{ agent_id: string; title: string; severity: string }>(
      `SELECT agent_id, title, severity FROM agent_events
       WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[]) AND status = 'open'
       ORDER BY detected_at DESC LIMIT 200`,
      [tenantId, sourceIds],
    )).rows;
    const connections: ConnectionRow[] = sourceIds.length === 0 ? [] : (await this.pool.query<ConnectionRow>(
      `SELECT c.agent_id, c.local_port, c.remote_address, c.remote_port, c.process, count(*)::text AS count
       FROM agent_connections c
       WHERE c.tenant_id = $1 AND c.agent_id = ANY($2::uuid[])
       GROUP BY c.agent_id, c.local_port, c.remote_address, c.remote_port, c.process
       ORDER BY count(*) DESC LIMIT 2000`,
      [tenantId, sourceIds],
    )).rows;
    const byAgent = new Map(agents.rows.map((agent) => [agent.id, agent]));
    const byIp = new Map<string, AgentRow>();
    for (const agent of agents.rows) {
      const ip = agent.system_info?.ip;
      if (typeof ip === 'string') byIp.set(ip, agent);
      const addresses = agent.system_info?.ipAddresses;
      if (Array.isArray(addresses)) {
        for (const address of addresses) if (typeof address === 'string') byIp.set(address, agent);
      }
    }
    const inventoryByAgent = new Map<string, InventoryRow[]>();
    for (const row of inventory.rows) {
      const list = inventoryByAgent.get(row.agent_id) ?? [];
      list.push(row);
      inventoryByAgent.set(row.agent_id, list);
    }
    const processLabel = (agentId: string, process: string): string => {
      const name = normalizeProcess(process);
      if (!name) return '';
      const rows = (inventoryByAgent.get(agentId) ?? []).filter((row) => row.kind === 'process' && row.name === name);
      if (rows.length === 1) {
        const row = rows[0];
        const command = row && typeof row.detail.command === 'string' ? row.detail.command : '';
        const service = jarService(command);
        if (service) return service;
      }
      return name;
    };
    const targetPort = (agentId: string, port: number): { service: string; name: string } | null => {
      const rows = (inventoryByAgent.get(agentId) ?? []).filter((row) => row.kind === 'port' && row.name.endsWith(`:${port}`));
      if (rows.length === 0) return null;
      const row = rows[0];
      if (!row) return null;
      const process = typeof row.detail.process === 'string' ? row.detail.process : '';
      return {
        service: processLabel(agentId, process) || row.name,
        name: row.name,
      };
    };
    const nodes = sourceIds.flatMap((id) => {
      const agent = byAgent.get(id);
      if (!agent) return [];
      const rows = inventoryByAgent.get(id) ?? [];
      const ports = rows.filter((row) => row.kind === 'port').map((row) => {
        const port = Number(row.name.slice(row.name.lastIndexOf(':') + 1));
        return { port, process: typeof row.detail.process === 'string' ? row.detail.process : '' };
      }).filter((item) => item.port > 0);
      const services = new Map<string, AccessTopologyService>();
      for (const item of ports) {
        const name = processLabel(id, item.process) || 'unknown';
        const current = services.get(name) ?? { name, ports: [] };
        if (!current.ports.includes(item.port)) current.ports.push(item.port);
        services.set(name, current);
      }
      return [{
        hostname: agent.hostname,
        appSystemId: agent.app_system_id,
        appSystemName: agent.app_system_name ?? '未归属',
        status: agent.status,
        ip: typeof agent.system_info?.ip === 'string' ? agent.system_info.ip : '',
        anomalies: events.filter((event) => event.agent_id === id).map((event) => `${event.severity}: ${event.title}`),
        services: [...services.values()].sort((a, b) => a.name.localeCompare(b.name)),
      }];
    });
    const internal = new Map<string, AccessTopologyEdge>();
    const external = new Map<string, AccessTopologyEdge>();
    for (const connection of connections) {
      const source = byAgent.get(connection.agent_id);
      const target = byIp.get(connection.remote_address);
      if (!source || !target || source.id === target.id) continue;
      if (connection.remote_address === '127.0.0.1' || connection.remote_address === '::1') continue;
      const targetInfo = targetPort(target.id, connection.remote_port);
      if (!targetInfo) continue;
      const fromService = processLabel(source.id, connection.process) || normalizeProcess(connection.process) || 'unknown';
      const edge: AccessTopologyEdge = {
        fromHost: source.hostname,
        fromService,
        toHost: target.hostname,
        toService: targetInfo.service,
        toPort: connection.remote_port,
        count: Number(connection.count),
        protocol: 'TCP',
        targetAppSystemId: target.app_system_id,
        targetAppSystemName: target.app_system_name ?? '未归属',
      };
      const key = `${edge.fromHost}|${edge.fromService}|${edge.toHost}|${edge.toService}|${edge.toPort}`;
      if (target.app_system_id === appSystemId) {
        const current = internal.get(key);
        if (current) current.count += edge.count;
        else internal.set(key, edge);
      } else {
        const externalKey = `${edge.targetAppSystemId}|${edge.fromHost}|${edge.fromService}|${edge.toHost}|${edge.toService}|${edge.toPort}`;
        const current = external.get(externalKey);
        if (current) current.count += edge.count;
        else external.set(externalKey, edge);
      }
    }
    const externalSystems = new Map<string, { appSystemId: string; appSystemName: string; edges: AccessTopologyEdge[] }>();
    for (const edge of external.values()) {
      const key = edge.targetAppSystemId ?? 'unknown';
      const current = externalSystems.get(key) ?? {
        appSystemId: edge.targetAppSystemId ?? '',
        appSystemName: edge.targetAppSystemName,
        edges: [],
      };
      current.edges.push(edge);
      externalSystems.set(key, current);
    }
    return {
      system: system.rows[0],
      nodes,
      edges: [...internal.values()].sort((a, b) => b.count - a.count),
      externalSystems: [...externalSystems.values()].map((item) => ({
        ...item,
        edges: item.edges.sort((a, b) => b.count - a.count),
      })).sort((a, b) => b.edges.reduce((sum, edge) => sum + edge.count, 0) - a.edges.reduce((sum, edge) => sum + edge.count, 0)),
    };
  }
}
