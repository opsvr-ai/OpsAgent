import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { notifyOperationsAlert } from '../src/agents/operations_alert.js';

afterEach(() => {
  delete process.env.OPSAGENT_OPERATIONS_ALERT_URL;
  delete process.env.OPSAGENT_OPERATIONS_ALERT_SECRET;
  delete process.env.OPSAGENT_OPERATIONS_ALERT_RETRIES;
});

describe('operations alert webhook', () => {
  it('posts alert payloads with HMAC signature', async () => {
    let received: { body: string; signature?: string } | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = {
          body: Buffer.concat(chunks).toString('utf8'),
          signature: typeof request.headers['x-opsagent-signature'] === 'string'
            ? request.headers['x-opsagent-signature']
            : undefined,
        };
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    process.env.OPSAGENT_OPERATIONS_ALERT_URL = `http://127.0.0.1:${address.port}/alert`;
    process.env.OPSAGENT_OPERATIONS_ALERT_SECRET = 'secret';
    notifyOperationsAlert({
      tenantId: 't-1',
      title: '审批 Webhook 连续投递失败',
      body: '3 条投递失败',
      severity: 'warning',
    });
    for (let attempt = 0; attempt < 30 && !received; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(received?.body).toContain('审批 Webhook 连续投递失败');
    expect(received?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('retries a transient failure', async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.statusCode = calls === 1 ? 500 : 204;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    process.env.OPSAGENT_OPERATIONS_ALERT_URL = `http://127.0.0.1:${address.port}/alert`;
    process.env.OPSAGENT_OPERATIONS_ALERT_RETRIES = '2';
    notifyOperationsAlert({
      tenantId: 't-1',
      title: '告警',
      body: '重试测试',
      severity: 'warning',
    });
    for (let attempt = 0; attempt < 50 && calls < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(calls).toBe(2);
  });
});
