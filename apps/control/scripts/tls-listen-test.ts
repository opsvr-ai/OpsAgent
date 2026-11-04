import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';

const certs = '.dev-certs';
const ca = readFileSync(`${certs}/ca.pem`);
const app = Fastify();
app.get('/ping', async () => ({ ok: true, tls: true }));
await app.listen({ host: '127.0.0.1', port: 18443 });
const handler = app.server.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;
const tlsServer = createServer({
  key: readFileSync(`${certs}/server-key.pem`),
  cert: readFileSync(`${certs}/server.pem`),
  ca,
  requestCert: true,
  rejectUnauthorized: true,
}, handler);
await new Promise<void>((resolve) => tlsServer.listen(18444, '127.0.0.1', resolve));

await new Promise<void>((resolve, reject) => {
  const req = request(
    {
      host: '127.0.0.1',
      port: 18444,
      path: '/ping',
      ca,
      cert: readFileSync(`${certs}/client.pem`),
      key: readFileSync(`${certs}/client-key.pem`),
      servername: 'localhost',
    },
    (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        console.log('tls status', res.statusCode, body);
        res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`));
      });
    },
  );
  req.on('error', reject);
  req.end();
});
await new Promise<void>((resolve, reject) => tlsServer.close((error) => error ? reject(error) : resolve()));
await app.close();
