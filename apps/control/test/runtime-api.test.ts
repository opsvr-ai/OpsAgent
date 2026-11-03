import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import type { AddressInfo } from 'node:net';
import { buildServer } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const demo = '00000000-0000-4000-8000-000000000001';
let pool: Pool;
let baseUrl: string;
let server: ReturnType<typeof buildServer>;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
  await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [
    await hash('correct horse battery staple'),
    'tenant-admin',
  ]);

  server = buildServer({
    pool,
    localAdmin: { enabled: true, username: 'tenant-admin' },
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.close();
  await pool.end();
});

async function login(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/local-admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tenant-admin', password: 'correct horse battery staple' }),
  });
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('missing session cookie');
  return cookie.split(';')[0] ?? '';
}

async function createSession(cookie: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ tenantId: demo, roleView: 'sre_duty' }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { sessionId: string };
  return body.sessionId;
}

function createEventReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';
  return async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = block.split('\n').find((item) => item.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6)) as Record<string, unknown>;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('stream ended before event');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}
describe('session API', () => {
  it('streams mock.echo and completes', async () => {
    const cookie = await login();
    const sessionId = await createSession(cookie);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: 'echo hello', idempotencyKey: 'api-echo' }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"tool":"mock.echo"');
    expect(text).toContain('"type":"session.done"');
  });

  it('pauses for approval and continues after approve', async () => {
    const cookie = await login();
    const sessionId = await createSession(cookie);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: 'restart service', idempotencyKey: 'api-restart' }),
    });
    expect(response.body).toBeTruthy();
    const reader = response.body!.getReader();
    const readEvent = createEventReader(reader);

    const first = await readEvent();
    expect(first.type).toBe('assistant.delta');
    const approval = await readEvent();
    expect(approval.type).toBe('approval.request');

    const listed = await fetch(`${baseUrl}/api/approvals`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    const approvals = (await listed.json()) as Array<{ id: string }>;
    expect(approvals.some((item) => item.id === approval.approvalId)).toBe(true);

    const decision = await fetch(`${baseUrl}/api/approvals/${String(approval.approvalId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(decision.status).toBe(200);

    const tool = await readEvent();
    expect(tool).toMatchObject({ type: 'tool.call', tool: 'mock.restart' });
    const result = await readEvent();
    expect(result.type).toBe('tool.result');
    const done = await readEvent();
    expect(done.type).toBe('session.done');
  });
});
