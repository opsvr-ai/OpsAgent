import 'reflect-metadata';
import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  AlgorithmIdentifier,
  Certificate,
} from '@peculiar/asn1-x509';
import {
  BasicOCSPResponse,
  CertStatus,
  id_pkix_ocsp_basic,
  OCSPRequest,
  OCSPResponse,
  OCSPResponseStatus,
  ResponderID,
  ResponseBytes,
  ResponseData,
  RevokedInfo,
  SingleResponse,
} from '@peculiar/asn1-ocsp';
import {
  AuthorityInfoAccessExtension,
  BasicConstraintsExtension,
  CRLDistributionPointsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  type Extension,
  KeyUsagesExtension,
  KeyUsageFlags,
  Pkcs10CertificateRequest,
  Pkcs10CertificateRequestGenerator,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
  X509CrlGenerator,
} from '@peculiar/x509';

export interface IssuedCertificate {
  readonly certificate: string;
  readonly ca: string;
  readonly serialNumber: string;
  readonly expiresAt: string;
}

export interface IssuedServerCertificate extends IssuedCertificate {
  readonly privateKey: string;
}

export interface IssueOptions {
  readonly usage?: 'client' | 'server';
  readonly dnsNames?: string[];
  readonly ipAddresses?: string[];
  readonly validityDays?: number;
}

function previousCaPems(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^ca-previous-.*\.pem$/.test(name))
    .sort()
    .map((name) => readFileSync(join(directory, name), 'utf8'));
}

export class AgentCaService {
  private constructor(
    private readonly ca: X509Certificate,
    private readonly caPem: string,
    private readonly caChainPem: string,
    private readonly signingKey: CryptoKey,
    private readonly keyObject: ReturnType<typeof createPrivateKey>,
    private readonly algorithm: 'ec' | 'rsa',
  ) {}

  static async fromEnv(): Promise<AgentCaService | null> {
    const certFile = process.env.OPSAGENT_AGENT_CA_CERT;
    const keyFile = process.env.OPSAGENT_AGENT_CA_KEY;
    if (certFile && keyFile) {
      const caPem = readFileSync(certFile, 'utf8');
      const keyPem = readFileSync(keyFile, 'utf8');
      const directory = process.env.OPSAGENT_AGENT_CA_DIR ?? '.opsagent-ca';
      return AgentCaService.create(caPem, keyPem, previousCaPems(directory));
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
    return AgentCaService.create(
      readFileSync(certFile, 'utf8'),
      readFileSync(keyFile, 'utf8'),
      previousCaPems(directory),
    );
  }

  static async create(caPem: string, keyPem: string, previousPems: string[] = []): Promise<AgentCaService> {
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
    const caChainPem = [caPem, ...previousPems].filter(Boolean).join('\n');
    return new AgentCaService(ca, caPem, caChainPem, cryptoKey, keyObject, algorithm);
  }

  get caCertificate(): string {
    return this.caPem;
  }

  async issueServer(dnsNames: string[], ipAddresses: string[]): Promise<IssuedServerCertificate> {
    const keys = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const csr = await Pkcs10CertificateRequestGenerator.create({
      name: 'CN=opsagent-control',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    });
    const issued = await this.issue(csr.toString('pem'), {
      usage: 'server',
      dnsNames,
      ipAddresses,
      validityDays: 90,
    });
    const keyDer = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
    const keyBase64 = Buffer.from(keyDer).toString('base64').replace(/(.{64})/g, '$1\n');
    return {
      ...issued,
      privateKey: `-----BEGIN PRIVATE KEY-----\n${keyBase64}\n-----END PRIVATE KEY-----\n`,
    };
  }

  async createOcspResponse(
    requestDer: Buffer,
    statuses: Map<string, Date | null>,
  ): Promise<Buffer> {
    const request = AsnConvert.parse(requestDer, OCSPRequest);
    const now = new Date();
    const caAsn1 = AsnConvert.parse(this.ca.rawData, Certificate);
    const issuerNameDer = Buffer.from(AsnConvert.serialize(caAsn1.tbsCertificate.subject));
    const issuerKeyDer = Buffer.from(caAsn1.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey);
    const responses = [];
    for (const item of request.tbsRequest.requestList) {
      const hashOid = item.reqCert.hashAlgorithm.algorithm;
      const hash = hashOid === '1.3.14.3.2.26' ? 'SHA-1' : hashOid === '2.16.840.1.101.3.4.2.1' ? 'SHA-256' : null;
      if (!hash) throw new Error('unsupported_ocsp_hash_algorithm');
      const [expectedNameHash, expectedKeyHash] = await Promise.all([
        crypto.subtle.digest(hash, issuerNameDer),
        crypto.subtle.digest(hash, issuerKeyDer),
      ]);
      if (Buffer.from(expectedNameHash).compare(Buffer.from(item.reqCert.issuerNameHash.buffer)) !== 0
        || Buffer.from(expectedKeyHash).compare(Buffer.from(item.reqCert.issuerKeyHash.buffer)) !== 0) {
        throw new Error('ocsp_issuer_mismatch');
      }
      const serial = Buffer.from(item.reqCert.serialNumber).toString('hex').replace(/^0+/, '').toLowerCase();
      const status = statuses.get(serial);
      const certStatus = status === undefined
        ? new CertStatus({ unknown: null })
        : status
          ? new CertStatus({ revoked: new RevokedInfo({ revocationTime: status }) })
          : new CertStatus({ good: null });
      responses.push(new SingleResponse({
        certID: item.reqCert,
        certStatus,
        thisUpdate: now,
        nextUpdate: new Date(now.getTime() + 60 * 60_000),
      }));
    }
    const responseData = new ResponseData({
      responderID: new ResponderID({ byName: caAsn1.tbsCertificate.subject }),
      producedAt: now,
      responses,
    });
    const tbs = Buffer.from(AsnConvert.serialize(responseData));
    const signature = this.algorithm === 'rsa'
      ? cryptoSign('sha256', tbs, this.keyObject)
      : cryptoSign('sha256', tbs, { key: this.keyObject, dsaEncoding: 'der' });
    const signatureAlgorithm = new AlgorithmIdentifier({
      algorithm: this.algorithm === 'rsa' ? '1.2.840.113549.1.1.11' : '1.2.840.10045.4.3.2',
    });
    const basic = new BasicOCSPResponse({
      tbsResponseData: responseData,
      signatureAlgorithm,
      signature: signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength),
      certs: [caAsn1],
    });
    const response = new OCSPResponse({
      responseStatus: OCSPResponseStatus.successful,
      responseBytes: new ResponseBytes({
        responseType: id_pkix_ocsp_basic,
        response: new OctetString(AsnConvert.serialize(basic)),
      }),
    });
    return Buffer.from(AsnConvert.serialize(response));
  }

  async createCrl(serials: string[]): Promise<string> {
    const crl = await X509CrlGenerator.create({
      issuer: this.ca.subject,
      signingKey: this.signingKey,
      signingAlgorithm: this.algorithm === 'rsa'
        ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
        : { name: 'ECDSA', hash: 'SHA-256' },
      thisUpdate: new Date(Date.now() - 60_000),
      nextUpdate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      entries: serials.map((serialNumber) => ({ serialNumber })),
    });
    return crl.toString('pem')
      .replace('BEGIN CRL', 'BEGIN X509 CRL')
      .replace('END CRL', 'END X509 CRL');
  }

  async issue(csrPem: string, options: IssueOptions = {}): Promise<IssuedCertificate> {
    const csr = new Pkcs10CertificateRequest(csrPem);
    if (!(await csr.verify())) throw new Error('invalid_csr_signature');
    const serialNumber = randomBytes(16).toString('hex');
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + (options.validityDays ?? 30) * 24 * 60 * 60 * 1000);
    const usage = options.usage ?? 'client';
    const extensions: Extension[] = [
      new BasicConstraintsExtension(false),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([
        usage === 'server' ? ExtendedKeyUsage.serverAuth : ExtendedKeyUsage.clientAuth,
      ]),
    ];
    if (usage === 'server') {
      extensions.push(new SubjectAlternativeNameExtension([
        ...(options.dnsNames ?? []).map((value) => ({ type: 'dns' as const, value })),
        ...(options.ipAddresses ?? []).map((value) => ({ type: 'ip' as const, value })),
      ]));
    }
    const crlUrl = process.env.OPSAGENT_CRL_URL;
    if (crlUrl) extensions.push(new CRLDistributionPointsExtension([crlUrl]));
    const ocspUrl = process.env.OPSAGENT_OCSP_URL;
    if (ocspUrl) extensions.push(new AuthorityInfoAccessExtension({ ocsp: [ocspUrl] }));
    const certificate = await X509CertificateGenerator.create({
      serialNumber,
      subject: csr.subject,
      issuer: this.ca.subject,
      notBefore,
      notAfter,
      publicKey: csr.publicKey,
      signingKey: this.signingKey,
      extensions,
    });
    return {
      certificate: certificate.toString('pem'),
      ca: this.caChainPem,
      serialNumber,
      expiresAt: notAfter.toISOString(),
    };
  }
}
