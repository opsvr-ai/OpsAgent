import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('desktop update feed', () => {
  it('serves latest.yml and installer metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opsagent-feed-'));
    writeFileSync(join(directory, 'latest.yml'), 'version: 0.2.0\n');
    writeFileSync(join(directory, 'OpsAgent Setup 0.2.0.exe'), 'installer');
    const app = buildServer({ desktopUpdateDir: directory });
    const latest = await app.inject({ method: 'GET', url: '/desktop/updates/latest.yml' });
    expect(latest.statusCode).toBe(200);
    expect(latest.body).toContain('version: 0.2.0');
    const installer = await app.inject({ method: 'GET', url: '/desktop/updates/OpsAgent%20Setup%200.2.0.exe' });
    expect(installer.statusCode).toBe(200);
    expect(installer.body).toBe('installer');
    const traversal = await app.inject({ method: 'GET', url: '/desktop/updates/..%2Fsecret' });
    expect(traversal.statusCode).toBe(404);
    await app.close();
  });
});
