import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { Redis } from 'ioredis';
import { Client } from 'ssh2';
import type { QueryFn } from './postgres.js';
import type { MysqlQueryFn } from './mysql.js';
import type { RedisClient } from './redis.js';
import type { SshExec, SshExecResult } from './ssh.js';

export function createPostgresQuery(
  connectionString: string,
): QueryFn & { close(): Promise<void> } {
  const pool = new Pool({ connectionString });
  const query: QueryFn = async (sql, params) => {
    const result = await pool.query(sql, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount };
  };
  return Object.assign(query, { close: () => pool.end() });
}

export function createMysqlQuery(
  url: string,
): MysqlQueryFn & { close(): Promise<void> } {
  const pool = mysql.createPool(url);
  const query: MysqlQueryFn = async (sql, params) => {
    const [rows] = await pool.query(sql, params as unknown[]);
    return { rows: rows as unknown[], rowCount: Array.isArray(rows) ? rows.length : 0 };
  };
  return Object.assign(query, { close: () => pool.end() });
}

export function createRedisClient(
  url: string,
): RedisClient & { close(): Promise<void> } {
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  const connect = async () => {
    if (redis.status === 'wait') await redis.connect();
    return redis;
  };
  return {
    info: async () => (await connect()).info(),
    get: async (key) => (await connect()).get(key),
    async scan(cursor, options) {
      const [next, keys] = await (await connect()).scan(
        cursor,
        'MATCH',
        options.MATCH,
        'COUNT',
        options.COUNT,
      );
      return { cursor: next, keys };
    },
    close: async () => {
      redis.disconnect();
    },
  };
}

export interface SshDriverConfig {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly password?: string;
  readonly privateKey?: string;
}

export function createSshExec(config: SshDriverConfig): SshExec {
  return (command) =>
    new Promise<SshExecResult>((resolve, reject) => {
      const client = new Client();
      client
        .on('ready', () => {
          client.exec(command, (error, stream) => {
            if (error) {
              client.end();
              reject(error);
              return;
            }
            let stdout = '';
            let stderr = '';
            stream.on('data', (chunk: Buffer) => {
              stdout += chunk.toString('utf8');
            });
            stream.stderr.on('data', (chunk: Buffer) => {
              stderr += chunk.toString('utf8');
            });
            stream.on('close', (code: number | undefined) => {
              client.end();
              resolve({ stdout, stderr, code: code ?? 0 });
            });
          });
        })
        .on('error', reject)
        .connect({
          host: config.host,
          port: config.port ?? 22,
          username: config.username,
          ...(config.password ? { password: config.password } : {}),
          ...(config.privateKey ? { privateKey: config.privateKey } : {}),
          readyTimeout: 10_000,
        });
    });
}
