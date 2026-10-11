const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const flags = process.allowedNodeEnvironmentFlags.has('--use-system-ca') ? ['--use-system-ca'] : [];
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [...flags, ...args], {cwd, stdio:'inherit', windowsHide:true});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `Command failed with exit ${result.status}.`);
}
function npm(args, cwd = root) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(cli)) throw new Error('Install the official Node.js 22+ distribution with npm to build from source.');
  run([cli, ...args, '--fetch-retries=0', '--fetch-timeout=60000'], cwd);
}
module.exports = {root, run, npm};
