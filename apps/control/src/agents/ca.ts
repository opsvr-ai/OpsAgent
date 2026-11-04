import 'reflect-metadata';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    if (!certFile || !keyFile) return null;
    const caPem = readFileSync(certFile, 'utf8');
    const keyPem = readFileSync(keyFile, 'utf8');
    return AgentCaService.create(caPem, keyPem);
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
