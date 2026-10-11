const fs = require('node:fs');
const path = require('node:path');
const {root, npm, run} = require('./tooling.cjs');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('請安裝 Node.js 22 以上，或下載 Windows 免安裝版。');
for (const directory of ['backend','extension']) if(!fs.existsSync(path.join(root,directory,'node_modules'))) npm(['ci'],path.join(root,directory));
run(['scripts/build.cjs']);
if (process.argv.includes('--browser')) {
  run(['dist/index.js','--dashboard',...(process.argv.includes('--no-browser')?[]:['--open'])],path.join(root,'backend'));
} else {
  const desktop = path.join(root,'desktop');
  if (!fs.existsSync(path.join(desktop,'node_modules/electron/dist/electron.exe'))) npm(['ci'],desktop);
  run([path.join(desktop,'node_modules/electron/cli.js'),desktop]);
}
