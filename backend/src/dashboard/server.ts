import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CommandBridge } from '../contracts/protocol.js';
import { Workspace, pickDirectory, folders } from './workspace.js';
import { Credentials } from './credentials.js';
import { AiClient } from './ai.js';
import { Controller } from './controller.js';
import { loadConversation } from './conversation.js';

async function body(request:IncomingMessage) {
  if(request.headers['content-type']!=='application/json')throw new Error('請使用 JSON 請求。');
  let length=0;const chunks:Buffer[]=[];
  for await(const chunk of request){length+=chunk.length;if(length>1024*1024)throw new Error('請求超過 1 MiB。');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function startDashboard(bridge:CommandBridge,dataDirectory:string,port:number,pairing:{version:number;url:string;token:string}) {
  const configDirectory=join(dataDirectory,'dashboard'), workspace=new Workspace(configDirectory),credentials=new Credentials(configDirectory);
  await mkdir(configDirectory, {recursive:true});
  await workspace.load();await credentials.load();
  const ai=new AiClient(credentials),controller=new Controller(workspace,bridge,ai);await controller.recover();
  const token=randomBytes(32).toString('hex'),staticDirectory=fileURLToPath(new URL('../../dashboard/',import.meta.url));
  let actualPort=port;
  const server=createServer((request,response)=>void (async()=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const origin=`http://127.0.0.1:${actualPort}`;
    if(request.headers.host!==`127.0.0.1:${actualPort}`){response.writeHead(403);response.end();return;}
    const url=new URL(request.url||'/',origin);
    if(!url.pathname.startsWith('/api/')){
      const paths:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      const item=paths[url.pathname];if(!item||request.method!=='GET'){response.writeHead(404);response.end();return;}
      response.setHeader('Content-Type',`${item[1]}; charset=utf-8`);response.end(await readFile(join(staticDirectory,item[0])));return;
    }
    const auth=request.headers.authorization||'',expected=`Bearer ${token}`;
    if(auth.length!==expected.length||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){response.writeHead(401);response.end();return;}
    if(request.headers.origin && request.headers.origin!==origin){response.writeHead(403);response.end();return;}
    response.setHeader('Content-Type','application/json; charset=utf-8');
    const send=(data:unknown)=>response.end(JSON.stringify(data));
    if(request.method==='GET'){
      if(url.pathname==='/api/state'){
        const run=controller.record ? {...controller.record,plan:{...controller.record.plan,conversationText:''},tests:controller.record.tests.map(t=>({...t,report:{verified:t.report.verified,metrics:t.report.metrics}}))} : null;
        send({bridge:bridge.status(),workspace:workspace.paths(),ai:credentials.status(),run,busy:controller.busy});return;
      }
      if(url.pathname==='/api/files'){send({files:await workspace.files()});return;}
      if(url.pathname==='/api/history'){send({runs:await controller.history()});return;}
      if(url.pathname==='/api/tabs'){send(await bridge.request('list_tabs',{}));return;}
      if(url.pathname==='/api/pairing'){response.setHeader('Content-Disposition','attachment; filename="pairing.json"');send(pairing);return;}
      if(url.pathname==='/api/file'){
        const path=await workspace.safePath(url.searchParams.get('path')||'');const stat=await lstat(path);
        if(!stat.isFile()||stat.size>100*1024*1024||!['.csv','.xlsx','.pine','.txt','.json','.md'].includes(extname(path).toLowerCase()))throw new Error('檔案類型或大小不支援。');
        response.setHeader('Content-Type','application/octet-stream');response.end(await readFile(path));return;
      }
    }
    if(request.method==='POST'){
      const input=await body(request);
      if(url.pathname==='/api/stop'){send({run:await controller.stop()});return;}
      if(controller.busy)throw new Error('研究執行中，請先停止後再改動設定。');
      if(url.pathname==='/api/pick-directory'){send({path:await pickDirectory()});return;}
      if(url.pathname==='/api/workspace'){
        const v=z.object({parent:z.string().min(1).max(1000),name:z.string().default('TradingViewResearch')}).parse(input);
        send(await workspace.initialize(v.parent,v.name));await controller.recover();return;
      }
      if(url.pathname==='/api/ai'){
        const v=z.object({model:z.string(),key:z.string().optional()}).parse(input);send(await credentials.save(v.model,v.key));return;
      }
      if(url.pathname==='/api/clear-key'){await credentials.clear();send({cleared:true});return;}
      if(url.pathname==='/api/models'){send({models:await ai.models()});return;}
      if(url.pathname==='/api/import'){
        const v=z.object({name:z.string(),source:z.string()}).parse(input);send({files:await workspace.import(v.name,v.source)});return;
      }
      if(url.pathname==='/api/conversation'){
        const v=z.object({conversationUrl:z.string().min(1).max(2000)}).parse(input);
        send(await loadConversation({...v,conversationText:''}));return;
      }
      if(url.pathname==='/api/chart'){
        const v=z.object({symbol:z.string().min(1).max(100),interval:z.string().min(1).max(20)}).parse(input);send(await bridge.request('prepare_chart',v));return;
      }
      if(url.pathname==='/api/configure-chart'){
        const v=z.object({tabId:z.number().int().positive(),timezone:z.literal('Etc/UTC')}).parse(input);send(await bridge.request('configure_chart',v));return;
      }
      if(url.pathname==='/api/parameters'){
        const v=z.object({tabId:z.number().int().positive()}).parse(input);
        send(await bridge.request('get_parameters',v));return;
      }
      if(url.pathname==='/api/open-folder'){
        const v=z.object({folder:z.enum(['root',...folders])}).parse(input);
        if(!workspace.root)throw new Error('請先建立工作資料夾。');
        const path=await workspace.safePath(v.folder==='root'?'.':v.folder);
        if(process.platform==='win32'){const child=spawn('explorer.exe',[path],{windowsHide:true});child.on('error',()=>{});}else throw new Error('此系統請複製面板上的資料夾路徑。');
        send({opened:true});return;
      }
      if(url.pathname==='/api/start'){
        if(input.analyze!==false || input.sourceMode!=='pine')credentials.getKey();
        send({run:await controller.start(input)});return;
      }
    }
    response.writeHead(404);send({error:'找不到操作。'});
  })().catch(error=>{
    if(response.writableEnded)return;
    response.statusCode=400;response.setHeader('Content-Type','application/json; charset=utf-8');
    const message=error instanceof z.ZodError ? error.issues.map(i=>i.message).join('；') : error instanceof Error ? error.message : '操作失敗。';
    response.end(JSON.stringify({error:credentials.redact(message)}));
  }));
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);const address=server.address();if(address&&typeof address!=='string')actualPort=address.port;resolve();});});
  return {server,controller,url:`http://127.0.0.1:${actualPort}/#${token}`,baseUrl:`http://127.0.0.1:${actualPort}`};
}
