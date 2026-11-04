import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.env.OPSAGENT_TLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.opsagent-ca');
const files = ['ca.pem', 'ca-key.pem', 'server.pem', 'server-key.pem', 'crl.pem'];
const archive = join(directory, `archive-${new Date().toISOString().replaceAll(':', '-')}`);

if (!existsSync(directory)) {
  console.log(`nothing to rotate: ${directory} does not exist`);
  process.exit(0);
}
mkdirSync(archive, { recursive: true, mode: 0o700 });
let moved = 0;
for (const name of files) {
  const source = join(directory, name);
  if (!existsSync(source)) continue;
  renameSync(source, join(archive, name));
  moved += 1;
  console.log(`archived ${name}`);
}
console.log(`archive=${archive}`);
console.log(`archived=${moved}`);
console.log('restart control to generate a new CA, server certificate and CRL');
console.log('restart Agents with OPSAGENT_AUTO_CSR=true to enroll new client certificates');
