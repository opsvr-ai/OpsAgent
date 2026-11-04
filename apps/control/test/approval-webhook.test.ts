import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { notifyApprovalWebhook } from '../src/agents/approval_webhook.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  delete process.env.OPSAGENT_APPROVAL_WEBHOOK_URL;
  delete process.env.OPSAGENT_APPROVAL_WEBHOOK_SECRET;
  delete process.env.OPSAGENT_APPROVAL_WEBHOOK_RETRIES;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('approval webhook', () => {
  it('posts approval events with an optional HMAC signature', async () => {
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
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    process.env.OPSAGENT_APPROVAL_WEBHOOK_URL = `http://127.0.0.1:${address.port}/hook`;
    process.env.OPSAGENT_APPROVAL_WEBHOOK_SECRET = 'secret';
    notifyApprovalWebhook({
      type: 'approval_requested',
      tenantId: 't-1',
      approvalId: 'a-1',
      agentId: 'g-1',
      hostname: 'host-1',
      action: 'service_restart',
      service: 'nginx',
      instruction: '重启 nginx 服务',
    });
    for (let attempt = 0; attempt < 30 && !received; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(received?.body).toContain('"approval_requested"');
    expect(received?.body).toContain('"service":"nginx"');
    expect(received?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('retries a transient webhook failure', async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.statusCode = calls === 1 ? 500 : 204;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    process.env.OPSAGENT_APPROVAL_WEBHOOK_URL = `http://127.0.0.1:${address.port}/hook`;
    process.env.OPSAGENT_APPROVAL_WEBHOOK_RETRIES = '2';
    notifyApprovalWebhook({
      type: 'approval_approved',
      tenantId: 't-1',
      approvalId: 'a-2',
      service: 'nginx',
    });
    for (let attempt = 0; attempt < 50 && calls < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(calls).toBe(2);
  });
});
