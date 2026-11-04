const { spawn } = require('node:child_process');
const path = require('node:path');
const electronPath = require('electron');

const electronDist = path.dirname(electronPath);
const args = process.argv.slice(2);
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(
  command,
  ['exec', 'electron-builder', ...args, `--config.electronDist=${electronDist}`],
  { cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: true },
);
child.on('exit', (code) => process.exit(code ?? 1));
