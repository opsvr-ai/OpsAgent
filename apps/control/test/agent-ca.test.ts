import 'reflect-metadata';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Pkcs10CertificateRequestGenerator,
  X509Certificate,
  X509CertificateGenerator,
} from '@peculiar/x509';
import { AgentCaService } from '../src/agents/ca.js';

const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const signing = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function pemKey(pair: CryptoKeyPair): Promise<string> {
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

describe('agent CA', () => {
  it('signs a valid CSR as a client certificate', async () => {
    const caKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const ca = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=OpsAgent Test CA',
      keys: caKeys,
      signingAlgorithm: signing,
    });
    const service = await AgentCaService.create(ca.toString('pem'), await pemKey(caKeys));
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const csr = await Pkcs10CertificateRequestGenerator.create({
      name: 'CN=agent-test',
      keys,
      signingAlgorithm: signing,
    });
    const issued = await service.issue(csr.toString('pem'));
    expect(issued.serialNumber).toHaveLength(32);
    expect(issued.ca).toContain('BEGIN CERTIFICATE');
    const certificate = new X509Certificate(issued.certificate);
    expect(certificate.subject).toContain('agent-test');
    expect(certificate.issuer).toContain('OpsAgent Test CA');
  });

  it('issues an internal server certificate with SANs', async () => {
    const caKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const ca = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=OpsAgent Test CA',
      keys: caKeys,
      signingAlgorithm: signing,
      extensions: [],
    });
    const service = await AgentCaService.create(ca.toString('pem'), await pemKey(caKeys));
    const issued = await service.issueServer(['localhost'], ['127.0.0.1']);
    expect(issued.privateKey).toContain('BEGIN PRIVATE KEY');
    const certificate = new X509Certificate(issued.certificate);
    expect(certificate.subject).toContain('opsagent-control');
  });

  it('creates and reuses an internal CA directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opsagent-ca-'));
    const previous = process.env.OPSAGENT_AGENT_CA_DIR;
    process.env.OPSAGENT_AGENT_CA_DIR = directory;
    delete process.env.OPSAGENT_AGENT_CA_CERT;
    delete process.env.OPSAGENT_AGENT_CA_KEY;
    try {
      const first = await AgentCaService.fromEnv();
      expect(first).not.toBeNull();
      expect(readFileSync(join(directory, 'ca.pem'), 'utf8')).toContain('BEGIN CERTIFICATE');
      const second = await AgentCaService.fromEnv();
      const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
      const csr = await Pkcs10CertificateRequestGenerator.create({
        name: 'CN=internal-agent',
        keys,
        signingAlgorithm: signing,
      });
      const issued = await second!.issue(csr.toString('pem'));
      expect(issued.ca).toBe(readFileSync(join(directory, 'ca.pem'), 'utf8'));
    } finally {
      if (previous === undefined) delete process.env.OPSAGENT_AGENT_CA_DIR;
      else process.env.OPSAGENT_AGENT_CA_DIR = previous;
    }
  });
});
