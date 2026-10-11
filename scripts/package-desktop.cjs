const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {root,run,npm} = require('./tooling.cjs');
async function main() {
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Build this Windows x64 release on Windows x64.');
  run(['scripts/audit-public.cjs']);run(['scripts/build.cjs']);
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
  const build=path.join(root,'.app-build',`app-${version}`);
  if(fs.existsSync(build))throw new Error('Build staging already exists. Use a new version or remove only .app-build after reviewing it.');
  fs.mkdirSync(path.join(build,'backend'),{recursive:true});
  for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(root,'backend',file),path.join(build,'backend',file));
  for(const directory of ['dist','dashboard'])fs.cpSync(path.join(root,'backend',directory),path.join(build,'backend',directory),{recursive:true});
  npm(['ci','--omit=dev','--ignore-scripts'],path.join(build,'backend'));
  for(const file of ['LICENSE','NOTICE','README.md','PRIVACY.md'])fs.copyFileSync(path.join(root,file),path.join(build,file));
  fs.cpSync(path.join(root,'docs'),path.join(build,'docs'),{recursive:true});
  fs.cpSync(path.join(root,'examples'),path.join(build,'examples'),{recursive:true});
  fs.cpSync(path.join(root,'extension/dist'),path.join(build,'extension'),{recursive:true});
  fs.copyFileSync(path.join(root,'desktop/main.cjs'),path.join(build,'main.cjs'));
  fs.writeFileSync(path.join(build,'package.json'),JSON.stringify({name:'local-strategy-research-studio',productName:'Local Strategy Research Studio',version,main:'main.cjs',author:'Local Strategy Research Studio contributors',license:'GPL-3.0-only',private:true},null,2));
  const {pathToFileURL}=require('node:url');
  const {packager}=await import(pathToFileURL(path.join(root,'desktop/node_modules/@electron/packager/dist/index.js')).href);
  const electronVersion=JSON.parse(fs.readFileSync(path.join(root,'desktop/node_modules/electron/package.json'))).version;
  const outputs=await packager({dir:build,out:path.join(root,'releases'),name:'LocalStrategyResearchStudio',executableName:'LocalStrategyResearchStudio',platform:'win32',arch:'x64',electronVersion,asar:false,prune:false,overwrite:false,appVersion:version,appCopyright:'Local Strategy Research Studio contributors',win32metadata:{ProductName:'Local Strategy Research Studio',FileDescription:'Local strategy research using your TradingView account and AI API key'}});
  const output=outputs[0];
  fs.cpSync(path.join(root,'extension/dist'),path.join(output,'TradingViewBridge'),{recursive:true});
  fs.copyFileSync(path.join(root,'docs/QUICKSTART.md'),path.join(output,'START-HERE.md'));
  const {zipSync}=require(path.join(root,'backend/node_modules/fflate'));
  const files=[],archive={};
  function add(directory,relative=''){
    for(const e of fs.readdirSync(directory,{withFileTypes:true})){
      const name=relative?`${relative}/${e.name}`:e.name;
      if(e.isSymbolicLink()||/(^|\/)(?:\.local|\.git|strategies|versions|runs|analysis)(\/|$)/.test(name))throw new Error('Non-public file in release allowlist: '+name);
      if(e.isDirectory())add(path.join(directory,e.name),name);else{
        const data=fs.readFileSync(path.join(directory,e.name));archive[name]=data;
        files.push({path:name,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});
      }
    }
  }
  add(output);
  archive['DISTRIBUTION.json']=Buffer.from(JSON.stringify({version,electronVersion,platform:'win32-x64',source:`https://github.com/charleswanghc/tradingview-strategy-research-studio/tree/v${version}`,privateDataIncluded:false,files},null,2));
  const zip=path.join(root,'releases',`local-strategy-research-studio-${version}-windows-x64.zip`);
  fs.writeFileSync(zip,zipSync(archive,{level:6}));
  const digest=crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  fs.writeFileSync(path.join(root,'releases','SHA256SUMS.txt'),`${digest}  ${path.basename(zip)}\n`);
  console.log(`Windows desktop release built: ${path.basename(zip)}; ${files.length+1} files; ${fs.statSync(zip).size} bytes.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
