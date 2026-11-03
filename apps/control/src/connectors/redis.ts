import type { Connector, ConnectorContext, ConnectorTool } from './types.js';

export interface RedisScanResult {
  readonly cursor: string;
  readonly keys: readonly string[];
}

export interface RedisClient {
  info(): Promise<string>;
  get(key: string): Promise<string | null>;
  scan(cursor: string, options: { MATCH: string; COUNT: number }): Promise<RedisScanResult>;
}

export interface RedisConfig {
  readonly client: RedisClient;
}

const MAX_SCAN_COUNT = 100;

export function createRedisConnector(config: RedisConfig): Connector {
  const tool: ConnectorTool = {
    name: 'redis_read',
    risk: 'R0',
    async execute(input: Readonly<Record<string, unknown>>, _context: ConnectorContext) {
      if (input.command === 'info') return config.client.info();
      if (input.command === 'get') {
        if (typeof input.key !== 'string' || input.key === '') throw new Error('key_required');
        return config.client.get(input.key);
      }
      if (input.command === 'scan') {
        const match = typeof input.match === 'string' ? input.match : '*';
        const requested = typeof input.count === 'number' ? input.count : 100;
        const count = Math.min(Math.max(Math.trunc(requested), 1), MAX_SCAN_COUNT);
        return config.client.scan('0', { MATCH: match, COUNT: count });
      }
      throw new Error('redis_command_not_allowed');
    },
  };
  return {
    manifest: { id: 'redis', name: 'Redis', version: '1.0.0' },
    tools: [tool],
  };
}
