const { execFileSync } = require('node:child_process');
const { existsSync, rmSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const output = path.join(root, 'release');
const unpacked = path.join(output, 'win-unpacked');
const archive = path.join(output, 'OpsAgent-win-x64.zip');

execFileSync(process.execPath, [path.join(__dirname, 'package.cjs'), '--dir'], {
  cwd: root,
  stdio: 'inherit',
});

if (!existsSync(unpacked)) {
  throw new Error(`missing packaged directory: ${unpacked}`);
}
rmSync(archive, { force: true });
execFileSync('tar', ['-a', '-c', '-f', archive, '-C', unpacked, '.'], {
  cwd: root,
  stdio: 'inherit',
});
console.log(`portable package: ${archive}`);
