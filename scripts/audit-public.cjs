const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const exclude = new Set(['.git','node_modules','dist','.extension-build','.local','.app-build','releases','.verify']);
const topFiles = new Set(['.gitignore','.gitattributes','package.json','package-lock.json','README.md','LICENSE','NOTICE','PRIVACY.md','SECURITY.md','CONTRIBUTING.md','StartResearch.cmd']);
const directories = new Set(['backend','extension','shared','desktop','scripts','docs','examples','.github']);
const secrets = [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g,/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,/\bAKIA[0-9A-Z]{16}\b/g];
const findings=[];let checked=0;
function walk(directory, relative='') {
  for(const e of fs.readdirSync(directory,{withFileTypes:true})) {
    if(exclude.has(e.name))continue;
    const name=relative?`${relative}/${e.name}`:e.name;
    if(e.isSymbolicLink()){findings.push(`${name}: symlink`);continue;}
    if(!relative && !(e.isDirectory()?directories.has(e.name):topFiles.has(e.name))){findings.push(`${name}: outside publication allowlist`);continue;}
    if(e.isDirectory()){if(['strategies','versions','runs','analysis','LocalStrategies','TradingViewResearch'].includes(e.name))findings.push(`${name}: user research directory`);else walk(path.join(directory,e.name),name);continue;}
    if(/(?:^|\/)(?:pairing|ai|workspace)\.json$|\.(?:env|pem|key|pfx|csv|xlsx|zip|exe)$|bridge-token$|launch-url\.txt$/.test(name)){findings.push(`${name}: private or generated artifact`);continue;}
    checked++;
    if(/\.(png|ico)$/.test(e.name))continue;
    const value=fs.readFileSync(path.join(directory,e.name),'utf8');
    for(const pattern of secrets){pattern.lastIndex=0;if(pattern.test(value))findings.push(`${name}: possible credential`);}
    if(/C:\\+Users\\+[^\s"<>\\]+\\/i.test(value))findings.push(`${name}: personal absolute path`);
    if(/tradingview\.com\/chart\/[A-Za-z0-9]{6,}\//.test(value))findings.push(`${name}: saved chart identifier`);
  }
}
walk(root);
if(findings.length){console.error(findings.join('\n'));process.exit(1);}
console.log(`Public-source audit passed: ${checked} allowlisted files; no credential patterns, saved chart IDs, personal user paths, reports or research directories.`);
