import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  CertID,
  BasicOCSPResponse,
  OCSPRequest,
  OCSPResponse,
  OCSPResponseStatus,
  Request,
  ResponseBytes,
  TBSRequest,
} from '@peculiar/asn1-ocsp';
import { AlgorithmIdentifier, Certificate } from '@peculiar/asn1-x509';
import { BasicConstraintsExtension, KeyUsageFlags, KeyUsagesExtension, X509CertificateGenerator } from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import { AgentCaService } from '../src/agents/ca.js';

describe('OCSP responder', () => {
  it('returns a successful DER response for a matching request', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const cert = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=OCSP Test CA',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 86_400_000),
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      ],
    });
    const keyDer = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(keyDer).toString('base64')}\n-----END PRIVATE KEY-----\n`;
    const ca = await AgentCaService.create(cert.toString('pem'), keyPem);
    const caAsn1 = AsnConvert.parse(cert.rawData, Certificate);
    const issuerNameHash = createHash('sha1')
      .update(Buffer.from(AsnConvert.serialize(caAsn1.tbsCertificate.subject)))
      .digest();
    const issuerKeyHash = createHash('sha1')
      .update(Buffer.from(caAsn1.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey))
      .digest();
    const request = new OCSPRequest({
      tbsRequest: new TBSRequest({
        requestList: [
          new Request({
            reqCert: new CertID({
              hashAlgorithm: new AlgorithmIdentifier({ algorithm: '1.3.14.3.2.26' }),
              issuerNameHash: new OctetString(issuerNameHash),
              issuerKeyHash: new OctetString(issuerKeyHash),
              serialNumber: new Uint8Array([0x12, 0x34]).buffer,
            }),
          }),
        ],
      }),
    });
    const requestDer = Buffer.from(AsnConvert.serialize(request));
    const responseDer = await ca.createOcspResponse(requestDer, new Map([['1234', null]]));
    const response = AsnConvert.parse(responseDer, OCSPResponse);
    expect(response.responseStatus).toBe(OCSPResponseStatus.successful);
    expect(response.responseBytes).toBeInstanceOf(ResponseBytes);
    const basic = AsnConvert.parse(response.responseBytes!.response.buffer, BasicOCSPResponse);
    expect(basic.tbsResponseData.responses[0]?.certStatus.good).toBeNull();
    expect(Buffer.from(basic.tbsResponseData.responses[0]!.certID.serialNumber).toString('hex')).toBe('1234');
  });
});
