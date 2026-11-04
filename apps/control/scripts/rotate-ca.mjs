import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.env.OPSAGENT_TLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.opsagent-ca');
const stamp = new Date().toISOString().replaceAll(':', '-');
const previousCert = join(directory, `ca-previous-${stamp}.pem`);
const previousKey = join(directory, `ca-key-previous-${stamp}.pem`);

if (!existsSync(directory)) {
  console.log(`nothing to rotate: ${directory} does not exist`);
  process.exit(0);
}
if (!existsSync(join(directory, 'ca.pem'))) {
  console.log('ca.pem not found; nothing to rotate');
  process.exit(0);
}
renameSync(join(directory, 'ca.pem'), previousCert);
if (existsSync(join(directory, 'ca-key.pem'))) {
  renameSync(join(directory, 'ca-key.pem'), previousKey);
}
rmSync(join(directory, 'crl.pem'), { force: true });
console.log(`previous certificate=${previousCert}`);
console.log(`previous key=${previousKey}`);
console.log('server certificate kept for the transition window');
console.log('restart control to generate a new CA; old client certificates stay valid');
console.log('after all Agents renew: delete ca-previous-* and server.pem/server-key.pem, then restart control');
