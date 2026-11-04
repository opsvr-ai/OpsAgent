const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const release = path.join(root, 'release');
const feed = path.join(release, 'feed');

execFileSync(process.execPath, [path.join(__dirname, 'package.cjs'), '--win', 'nsis'], {
  cwd: root,
  stdio: 'inherit',
});

const latest = readFileSync(path.join(release, 'latest.yml'), 'utf8');
const version = /^version:\s*(.+)$/m.exec(latest)?.[1]?.trim();
if (!version) throw new Error('latest.yml is missing a version');
mkdirSync(feed, { recursive: true });
for (const name of readdirSync(feed)) rmSync(path.join(feed, name), { force: true });
const installer = `OpsAgent Setup ${version}.exe`;
const files = ['latest.yml', installer, `${installer}.blockmap`];
for (const name of files) {
  copyFileSync(path.join(release, name), path.join(feed, name));
}
console.log(`update feed ready: ${feed} (version ${version})`);
