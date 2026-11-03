import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Server } from 'ssh2';
import { createSshExec } from '../src/connectors/drivers.js';
import { createSshConnector } from '../src/connectors/ssh.js';

let server: Server;
let port = 0;

beforeAll(async () => {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  });
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'ops' && ctx.password === 'pw') {
        ctx.accept();
      } else {
        ctx.reject();
      }
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec) => {
          const stream = acceptExec();
          stream.write('up 1 day\n');
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') port = address.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('live SSH driver', () => {
  it('executes a fixed read-only check', async () => {
    const exec = createSshExec({ host: '127.0.0.1', port, username: 'ops', password: 'pw' });
    const tool = createSshConnector({ exec }).tools[0];
    const result = await tool?.execute({ check: 'uptime' }, { tenantId: 't' });
    expect(result).toMatchObject({ code: 0 });
    expect(String((result as { stdout: string }).stdout)).toContain('up 1 day');
  });
});
