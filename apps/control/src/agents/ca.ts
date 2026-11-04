import 'reflect-metadata';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  Pkcs10CertificateRequest,
  X509Certificate,
  X509CertificateGenerator,
} from '@peculiar/x509';

export interface IssuedCertificate {
  readonly certificate: string;
  readonly ca: string;
  readonly serialNumber: string;
  readonly expiresAt: string;
}

export class AgentCaService {
  private constructor(
    private readonly ca: X509Certificate,
    private readonly caPem: string,
    private readonly signingKey: CryptoKey,
    private readonly algorithm: 'ec' | 'rsa',
  ) {}

  static async fromEnv(): Promise<AgentCaService | null> {
    const certFile = process.env.OPSAGENT_AGENT_CA_CERT;
    const keyFile = process.env.OPSAGENT_AGENT_CA_KEY;
    if (certFile && keyFile) {
      const caPem = readFileSync(certFile, 'utf8');
      const keyPem = readFileSync(keyFile, 'utf8');
      return AgentCaService.create(caPem, keyPem);
    }
    if (process.env.OPSAGENT_AGENT_CA_AUTO === 'false') return null;
    return AgentCaService.createInternalCa(process.env.OPSAGENT_AGENT_CA_DIR ?? '.opsagent-ca');
  }

  private static async createInternalCa(directory: string): Promise<AgentCaService> {
    const certFile = join(directory, 'ca.pem');
    const keyFile = join(directory, 'ca-key.pem');
    if (!existsSync(certFile) || !existsSync(keyFile)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const keys = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const certificate = await X509CertificateGenerator.createSelfSigned({
        name: 'CN=OpsAgent Internal CA',
        keys,
        signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
        extensions: [
          new BasicConstraintsExtension(true, 0, true),
          new KeyUsagesExtension(
            KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign | KeyUsageFlags.digitalSignature,
            true,
          ),
        ],
      });
      const keyDer = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
      const keyBase64 = Buffer.from(keyDer).toString('base64').replace(/(.{64})/g, '$1\n');
      writeFileSync(certFile, certificate.toString('pem'), { mode: 0o600 });
      writeFileSync(
        keyFile,
        `-----BEGIN PRIVATE KEY-----\n${keyBase64}\n-----END PRIVATE KEY-----\n`,
        { mode: 0o600 },
      );
    }
    return AgentCaService.create(readFileSync(certFile, 'utf8'), readFileSync(keyFile, 'utf8'));
  }

  static async create(caPem: string, keyPem: string): Promise<AgentCaService> {
    const ca = new X509Certificate(caPem);
    const keyObject = createPrivateKey(keyPem);
    const algorithm = keyObject.asymmetricKeyType === 'rsa' ? 'rsa' : 'ec';
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      keyObject.export({ format: 'der', type: 'pkcs8' }),
      algorithm === 'rsa'
        ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
        : { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    return new AgentCaService(ca, caPem, cryptoKey, algorithm);
  }

  async issue(csrPem: string): Promise<IssuedCertificate> {
    const csr = new Pkcs10CertificateRequest(csrPem);
    if (!(await csr.verify())) throw new Error('invalid_csr_signature');
    const serialNumber = randomBytes(16).toString('hex');
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const certificate = await X509CertificateGenerator.create({
      serialNumber,
      subject: csr.subject,
      issuer: this.ca.subject,
      notBefore,
      notAfter,
      publicKey: csr.publicKey,
      signingKey: this.signingKey,
      extensions: [
        new BasicConstraintsExtension(false),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth]),
      ],
    });
    return {
      certificate: certificate.toString('pem'),
      ca: this.caPem,
      serialNumber,
      expiresAt: notAfter.toISOString(),
    };
  }
}
