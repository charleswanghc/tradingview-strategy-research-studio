const {app, BrowserWindow, dialog, shell, session} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const net = require('node:net');
const {spawn} = require('node:child_process');
const smoke = process.argv.includes('--smoke-test');
const testDirectory = process.argv.find(a => a.startsWith('--test-data='));
if (smoke && testDirectory) app.setPath('userData',path.resolve(testDirectory.slice('--test-data='.length)));
app.setName('Local Strategy Research Studio');
const appRoot = app.isPackaged ? app.getAppPath() : path.resolve(__dirname,'..');
const service = path.join(appRoot,'backend');
let child, launch, mainWindow, exiting = false;
async function freePort() {
  const server=net.createServer(); await new Promise((ok,bad)=>server.once('error',bad).listen(0,'127.0.0.1',ok));
  const port=server.address().port; await new Promise(ok=>server.close(ok)); return port;
}
async function startService() {
  const data=path.join(app.getPath('userData'),'service'); await fs.mkdir(data,{recursive:true});
  const bridgePort=await freePort(); let dashboardPort=await freePort(); while(dashboardPort===bridgePort)dashboardPort=await freePort();
  const launchFile=path.join(data,'dashboard/launch-url.txt'); await fs.rm(launchFile,{force:true});
  const nodeFlags=process.allowedNodeEnvironmentFlags.has('--use-system-ca')?['--use-system-ca']:[];
  child=spawn(process.execPath,[...nodeFlags,path.join(service,'dist/index.js'),'--dashboard'],{
    cwd:service,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TVA_DATA_DIR:data,TVA_BRIDGE_PORT:String(bridgePort),TVA_DASHBOARD_PORT:String(dashboardPort)},
    stdio:['ignore','pipe','pipe','ipc'],windowsHide:true
  });
  let failed; child.once('error',e=>{failed=e;}); child.once('exit',code=>{if(!exiting)failed=new Error(`Local service exited (${code}).`);});
  // Logs include status and paths, never the key or authenticated launch URL.
  child.stdout.on('data',()=>{}); child.stderr.on('data',()=>{});
  const deadline=Date.now()+30000;
  while(Date.now()<deadline) {
    if(failed)throw failed;
    try {
      const value=await fs.readFile(launchFile,'utf8');const url=new URL(value);
      if(url.origin!==`http://127.0.0.1:${dashboardPort}`||!/^#[a-f0-9]{64}$/.test(url.hash))throw new Error('Invalid local launch URL.');
      const response=await fetch(`${url.origin}/api/state`,{headers:{Authorization:`Bearer ${url.hash.slice(1)}`},signal:AbortSignal.timeout(2000)});
      if(response.ok){launch=url;return await response.json();}
    } catch(e) {if(e.message==='Invalid local launch URL.')throw e;}
    await new Promise(ok=>setTimeout(ok,100));
  }
  throw new Error('本地研究室未能啟動，請確認應用程式解壓縮完整且資料夾可寫入。');
}
function external(url) {
  try {const u=new URL(url);return u.protocol==='https:'&&['www.tradingview.com','tradingview.com','github.com'].includes(u.hostname)&&!u.username&&!u.password;}catch{return false;}
}
async function shutdown() {
  if(exiting)return;exiting=true;
  if(child&&child.exitCode===null) {
    if(child.connected)child.send({type:'studio-shutdown'});
    await Promise.race([new Promise(ok=>child.once('exit',ok)),new Promise(ok=>setTimeout(ok,8000))]);
    if(child.exitCode===null)child.kill();
  }
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.focus();}});
  app.whenReady().then(async()=>{
    const state=await startService();
    session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    mainWindow=new BrowserWindow({width:1360,height:960,minWidth:720,minHeight:620,show:false,title:'Local Strategy Research Studio',
      webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.setWindowOpenHandler(({url})=>{if(external(url))void shell.openExternal(url);return {action:'deny'};});
    mainWindow.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==launch.origin){event.preventDefault();if(external(url))void shell.openExternal(url);}});
    mainWindow.once('ready-to-show',()=>{if(!smoke)mainWindow.show();});
    await mainWindow.loadURL(launch.href);
    if(smoke){
      const preferences=mainWindow.webContents.getLastWebPreferences();
      if(state.busy||state.workspace!==null||state.ai.hasKey||state.bridge.connected)throw new Error('First-launch state was not clean.');
      if(preferences.nodeIntegration||!preferences.contextIsolation||!preferences.sandbox)throw new Error('Desktop renderer isolation failed.');
      console.log('Desktop executable and sandboxed renderer loaded; first-launch state is clean.');
      await shutdown();app.quit();return;
    }
  }).catch(async error=>{
    if(smoke)console.error(error.message);else dialog.showErrorBox('策略研究室啟動失敗',error.message);
    await shutdown();app.exit(1);
  });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(!exiting){event.preventDefault();void shutdown().then(()=>app.quit());}});
}
