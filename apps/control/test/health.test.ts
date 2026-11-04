import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('control plane health', () => {
  it('reports ok with the service name', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'opsagent-control' });
    await app.close();
  });
});
