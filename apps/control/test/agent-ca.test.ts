import 'reflect-metadata';
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
});
