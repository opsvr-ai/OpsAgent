import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentCaService } from '../agents/ca.js';

/** Public CRL and OCSP endpoints referenced by issued certificates. */
export function registerPkiRoutes(app: FastifyInstance, pool?: Pool): void {
  app.addContentTypeParser(
    'application/ocsp-request',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  const caPromise = AgentCaService.fromEnv();

  async function respond(requestDer: Buffer): Promise<Buffer | null> {
    const ca = await caPromise;
    if (!ca || !pool) return null;
    const rows = await pool.query<{
      tls_cert_serial: string | null;
      certificate_revoked_at: Date | null;
    }>(
      `SELECT tls_cert_serial, certificate_revoked_at FROM agents
       WHERE tls_cert_serial IS NOT NULL`,
    );
    const statuses = new Map<string, Date | null>();
    for (const row of rows.rows) {
      if (!row.tls_cert_serial) continue;
      const serial = row.tls_cert_serial.replaceAll(':', '').toLowerCase().replace(/^0+/, '');
      statuses.set(serial, row.certificate_revoked_at);
    }
    return ca.createOcspResponse(requestDer, statuses);
  }

  app.get('/api/pki/crl', async (_request, reply) => {
    const directory = process.env.OPSAGENT_TLS_DIR ?? '.opsagent-ca';
    const file = join(directory, 'crl.pem');
    if (!existsSync(file)) return reply.code(404).send({ error: 'crl_not_found' });
    reply.header('cache-control', 'no-cache');
    reply.type('application/pkix-crl');
    return reply.send(readFileSync(file));
  });

  app.post('/api/pki/ocsp', async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'invalid_ocsp_request' });
    try {
      const response = await respond(body);
      if (!response) return reply.code(503).send({ error: 'ocsp_unavailable' });
      reply.header('cache-control', 'no-cache');
      reply.type('application/ocsp-response');
      return reply.send(response);
    } catch (error) {
      console.error('ocsp response failed', error);
      return reply.code(400).send({ error: 'invalid_ocsp_request' });
    }
  });

  app.get<{ Params: { request: string } }>('/api/pki/ocsp/:request', async (request, reply) => {
    try {
      const input = Buffer.from(request.params.request, 'base64url');
      const response = await respond(input);
      if (!response) return reply.code(503).send({ error: 'ocsp_unavailable' });
      reply.header('cache-control', 'no-cache');
      reply.type('application/ocsp-response');
      return reply.send(response);
    } catch (error) {
      console.error('ocsp get response failed', error);
      return reply.code(400).send({ error: 'invalid_ocsp_request' });
    }
  });
}
