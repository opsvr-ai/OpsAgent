import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const agentDir = join(root, 'agents', 'opsagent-agent');
const outDir = join(agentDir, 'dist');
mkdirSync(outDir, { recursive: true });

const targets = [
  { goos: 'linux', goarch: 'amd64', name: 'opsagent-agent-linux-amd64' },
  { goos: 'linux', goarch: 'arm64', name: 'opsagent-agent-linux-arm64' },
  { goos: 'windows', goarch: 'amd64', name: 'opsagent-agent-windows-amd64.exe' },
];

for (const target of targets) {
  const out = join(outDir, target.name);
  console.log(`building ${target.name}`);
  const result = spawnSync('go', ['build', '-o', out, '.'], {
    cwd: agentDir,
    stdio: 'inherit',
    env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
console.log(`agent binaries written to ${outDir}`);
