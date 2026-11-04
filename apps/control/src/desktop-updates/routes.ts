import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Serves the desktop auto-update feed from a directory mounted read-only.
 * Public endpoint: Electron autoUpdater has no session cookie.
 */
export function registerDesktopUpdateRoutes(app: FastifyInstance, directory?: string): void {
  if (!directory) return;
  app.get<{ Params: { file: string } }>('/desktop/updates/:file', async (request, reply) => {
    const name = basename(request.params.file);
    if (!/^(latest\.yml|OpsAgent[- .A-Za-z0-9]+\.(exe|blockmap))$/.test(name)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const target = join(directory, name);
    if (!existsSync(target) || !statSync(target).isFile()) {
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('cache-control', 'no-cache');
    reply.type(name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream');
    return reply.send(createReadStream(target));
  });
}
