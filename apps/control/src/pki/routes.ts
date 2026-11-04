import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Public CRL endpoint referenced by issued client certificates. */
export function registerPkiRoutes(app: FastifyInstance): void {
  app.get('/api/pki/crl', async (_request, reply) => {
    const directory = process.env.OPSAGENT_TLS_DIR ?? '.opsagent-ca';
    const file = join(directory, 'crl.pem');
    if (!existsSync(file)) return reply.code(404).send({ error: 'crl_not_found' });
    reply.header('cache-control', 'no-cache');
    reply.type('application/pkix-crl');
    return reply.send(readFileSync(file));
  });
}
