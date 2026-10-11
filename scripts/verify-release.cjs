const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {root}=require('./tooling.cjs');
const {unzipSync}=require(path.join(root,'backend/node_modules/fflate'));
async function main(){
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
  const zip=path.join(root,'releases',`local-strategy-research-studio-${version}-windows-x64.zip`);
  const contents=unzipSync(fs.readFileSync(zip));
  const manifest=JSON.parse(Buffer.from(contents['DISTRIBUTION.json']).toString('utf8'));
  if(Object.keys(contents).length!==manifest.files.length+1)throw new Error('Release entry count mismatch.');
  for(const file of manifest.files){
    if(!contents[file.path]||contents[file.path].length!==file.bytes||crypto.createHash('sha256').update(contents[file.path]).digest('hex')!==file.sha256)throw new Error('Release hash mismatch.');
    if(file.path.includes('..')||path.isAbsolute(file.path)||/(^|\/)(\.git|\.local|strategies|versions|runs|analysis)(\/|$)/.test(file.path)||/pairing\.json|bridge-token|ai\.json|workspace\.json|\.(csv|xlsx)$/.test(file.path))throw new Error('Private or unsafe entry in release.');
  }
  const directory=path.join(root,'.verify',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
  try{
    for(const [name,data]of Object.entries(contents)){const target=path.join(directory,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);}
    const child=spawn(path.join(directory,'LocalStrategyResearchStudio.exe'),['--smoke-test',`--test-data=${path.join(directory,'test-data')}`],{cwd:directory,windowsHide:true});
    let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
    const timer=setTimeout(()=>child.kill(),40000);
    const code=await new Promise((ok,bad)=>{child.once('exit',ok);child.once('error',bad);});clearTimeout(timer);
    if(code!==0||!output.includes('first-launch state is clean'))throw new Error('Desktop first-launch check failed: '+output);
    console.log(`Verified ${manifest.files.length+1} release entries and hashes. Packaged EXE launches without Node.js, personal settings, account session or API Key.`);
  }finally{
    const actual=fs.realpathSync(directory),parent=fs.realpathSync(path.join(root,'.verify'));
    if(path.dirname(actual)!==parent)throw new Error('Refusing cleanup outside the verification folder.');
    fs.rmSync(actual,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
