import type { Pool } from 'pg';

interface ConnectionInput {
  localAddress?: unknown;
  localPort?: unknown;
  remoteAddress?: unknown;
  remotePort?: unknown;
  process?: unknown;
  pid?: unknown;
  direction?: unknown;
  service?: unknown;
  command?: unknown;
}

export class AgentConnectionService {
  constructor(private readonly pool: Pool) {}

  async sync(tenantId: string, agentId: string, value: unknown): Promise<number> {
    if (!Array.isArray(value)) return 0;
    const connections = value
      .filter((item): item is ConnectionInput => typeof item === 'object' && item !== null)
      .slice(0, 500);
    await this.pool.query('DELETE FROM agent_connections WHERE tenant_id = $1 AND agent_id = $2', [tenantId, agentId]);
    for (const connection of connections) {
      const localAddress = typeof connection.localAddress === 'string' ? connection.localAddress : '';
      const remoteAddress = typeof connection.remoteAddress === 'string' ? connection.remoteAddress : '';
      const localPort = typeof connection.localPort === 'number' ? connection.localPort : Number(connection.localPort) || 0;
      const remotePort = typeof connection.remotePort === 'number' ? connection.remotePort : Number(connection.remotePort) || 0;
      if (!remoteAddress || !remotePort) continue;
      await this.pool.query(
        `INSERT INTO agent_connections
           (tenant_id, agent_id, local_address, local_port, remote_address, remote_port, process, pid, direction, service, command, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ESTAB')
         ON CONFLICT (tenant_id, agent_id, local_address, local_port, remote_address, remote_port, process)
         DO UPDATE SET pid = EXCLUDED.pid, direction = EXCLUDED.direction,
           service = EXCLUDED.service, command = EXCLUDED.command, updated_at = now()`,
        [
          tenantId, agentId, localAddress, localPort, remoteAddress, remotePort,
          typeof connection.process === 'string' ? connection.process.slice(0, 500) : '',
          typeof connection.pid === 'number' ? connection.pid : Number(connection.pid) || 0,
          typeof connection.direction === 'string' ? connection.direction : 'outbound',
          typeof connection.service === 'string' ? connection.service.slice(0, 200) : '',
          typeof connection.command === 'string' ? connection.command.slice(0, 1000) : '',
        ],
      );
    }
    return connections.length;
  }
}
