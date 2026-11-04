import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

const previous = process.env.OPSAGENT_TLS_DIR;

afterEach(() => {
  if (previous === undefined) delete process.env.OPSAGENT_TLS_DIR;
  else process.env.OPSAGENT_TLS_DIR = previous;
});

describe('PKI routes', () => {
  it('serves the current CRL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opsagent-crl-'));
    writeFileSync(join(directory, 'crl.pem'), '-----BEGIN X509 CRL-----\n');
    process.env.OPSAGENT_TLS_DIR = directory;
    const app = buildServer({});
    const response = await app.inject({ method: 'GET', url: '/api/pki/crl' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pkix-crl');
    expect(response.body).toContain('BEGIN X509 CRL');
    await app.close();
  });
});
