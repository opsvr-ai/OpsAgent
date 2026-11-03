import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const source = process.env.DSH_HOST_HOME ?? join(homedir(), '.dsh');
const target = process.env.DSH_RUNTIME_HOME ?? join(process.cwd(), '.dsh-runtime');
const credentials = join(source, '.credentials.yaml');
const headlessSource = join(source, 'profiles', 'headless');
const headlessTarget = join(target, 'profiles', 'headless');

if (!existsSync(credentials)) {
  console.error(`missing dsh credentials: ${credentials}`);
  console.error('Sign in to DeepSeek Harness once, then run this script again.');
  process.exit(1);
}

mkdirSync(headlessTarget, { recursive: true });
copyFileSync(credentials, join(target, '.credentials.yaml'));
for (const file of readdirSync(headlessSource)) {
  const path = join(headlessSource, file);
  if (statSync(path).isFile() && (file === 'package.json' || file === 'cordis.patch.yml')) {
    copyFileSync(path, join(headlessTarget, file));
  }
}
console.log(`dsh runtime home prepared at ${target}`);
