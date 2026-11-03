import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { sendWebhook } from '../src/messages/webhook.js';

let server: Server;
let url = '';
let received = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    request.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    request.on('end', () => {
      response.statusCode = 200;
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') url = `http://127.0.0.1:${address.port}/hook`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('webhook notifications', () => {
  it('posts a JSON notification', async () => {
    await sendWebhook({ title: 't', body: 'b', severity: 'warning' }, url);
    expect(JSON.parse(received)).toMatchObject({ title: 't', body: 'b', severity: 'warning' });
  });
});
