import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { zipSync, strToU8 } from 'fflate';
import { Workspace } from '../dist/dashboard/workspace.js';
import { preparePine } from '../dist/dashboard/pine.js';
import { planSchema, settingsSchema, combinations } from '../dist/dashboard/config.js';
import { analyzeReport } from '../dist/dashboard/report.js';
import { AiClient } from '../dist/dashboard/ai.js';
import { Credentials } from '../dist/dashboard/credentials.js';
import { Controller } from '../dist/dashboard/controller.js';
import { startDashboard } from '../dist/dashboard/server.js';
import { createChromeFixture, bridgeModule, until } from './fixtures.mjs';

const base = fileURLToPath(new URL('../.local/', import.meta.url));
const source='//@version=6\nstrategy("Fixture, (v1)", overlay=true, slippage=0)\nlength = input.int(3, "Length")\nstrategy.entry("L", strategy.long)\n';
const plan=()=>planSchema.parse({tabId:1,sourceMode:'pine',sourceFile:'fixture.pine',period:{start:'2020-01-01',end:'2025-12-31'},settings:{capital:500000,quantity:1,commission:2,slippage:10},maxRounds:2,maxTests:4,parameters:{Length:[2,4]},aiConsent:true});
async function temporary(t){await mkdir(base,{recursive:true});const directory=await mkdtemp(join(base,'dashboard-test-'));t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(base)));await rm(directory,{recursive:true,force:true});});return directory;}
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
function xlsx(tables){
  const items={};let index=0;const sheets=[],rels=[];
  for(const [name,rows]of Object.entries(tables)){
    index++;sheets.push(`<sheet name="${escape(name)}" sheetId="${index}" r:id="rId${index}"/>`);rels.push(`<Relationship Id="rId${index}" Target="worksheets/sheet${index}.xml"/>`);
    const cell=(v,r,c)=>`<c r="${String.fromCharCode(65+c)}${r+1}"${typeof v==='number'?'':' t="inlineStr"'}>${typeof v==='number'?`<v>${v}</v>`:`<is><t>${escape(v)}</t></is>`}</c>`;
    items[`xl/worksheets/sheet${index}.xml`]=strToU8(`<worksheet><sheetData>${rows.map((row,r)=>`<row r="${r+1}">${row.map((v,c)=>cell(v,r,c)).join('')}</row>`).join('')}</sheetData></worksheet>`);
  }
  items['xl/workbook.xml']=strToU8(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.join('')}</sheets></workbook>`);
  items['xl/_rels/workbook.xml.rels']=strToU8(`<Relationships>${rels.join('')}</Relationships>`);return zipSync(items);
}
function exports(title,profit=20,length=2){
  const header=['Trade number','Type','Date and time','Signal','Price USD','Size (qty)','Net PnL USD','Commission USD'];
  const rows=[[1,'Exit long','2021-02-01','Exit',100,1,profit,4],[1,'Entry long','2021-01-01','Entry',90,1,profit,4]];
  const props=[['Property','Value'],['Name',title],['Backtesting range','Jan 1, 2020 — Dec 31, 2025'],['Symbol','COMEX:GC1!'],['Timeframe','1 day'],['Chart type','Candles'],['Currency','USD'],['Initial capital','500000'],['Default order size','1 contracts'],['Commission','2'],['Slippage','10 ticks'],['Script execution','On bar close'],['Bar detalization','Default (4 ticks per bar)'],['Pyramiding','0'],['Long leverage','Infinity'],['Short leverage','Infinity'],['Length',length]];
  const tables={Trades:[header,...rows],Properties:props,Performance:[['','All USD','All %'],['Net profit',profit],['Gross profit',profit],['Gross loss',0],['Open PnL',0],['Commission paid',4],['Max drawdown (intrabar)',9.5,1.2],['Annualized return (CAGR)','',.3]],'Risk-adjusted performance':[['Profit factor',2]]};
  return {csv:[header,...rows].map(r=>r.join(',')).join('\n')+'\n',xlsx:xlsx(tables),tables};
}

test('workspace imports only local text files without overwriting and blocks path traversal',async t=>{
  const directory=await temporary(t),w=new Workspace(join(directory,'config'));await w.initialize(directory,'Research');
  await w.import('fixture.pine',source);assert.equal(await w.source('fixture.pine'),source);
  await assert.rejects(()=>w.import('fixture.pine','overwrite'),/EEXIST/);
  await assert.rejects(()=>w.import('../escape.txt','escape'),/匯入/);
  await assert.rejects(()=>w.safePath('../config'),/超出/);
  assert.match(await readFile(join(w.root,'.gitignore'),'utf8'),/\*/);
});
test('Pine baseline replaces execution settings while preserving quoted commas and strategy logic',()=>{
  const result=preparePine(source,'Fixed title',settingsSchema.parse({slippage:10}));
  assert.match(result,/slippage=10/);assert.match(result,/commission_type=strategy.commission.cash_per_contract/);
  assert.match(result,/default_qty_type=strategy.fixed/);assert.match(result,/margin_long=0/);
  assert.match(result,/length = input.int/);assert.equal((result.match(/slippage=/g)||[]).length,1);
  assert.throws(()=>preparePine('//@version=6\nstrategy("T", true)','T',settingsSchema.parse({})),/具名/);
  assert.equal(combinations({Length:[2,2,4],Enabled:[true,false]},4).length,4);
  assert.throws(()=>combinations({Length:[1,2,3],Enabled:[true,false]},5),/超過/);
  assert.throws(()=>planSchema.parse({...plan(),aiConsent:false}),/同意/);
});
test('report parser pairs trades once, validates XLSX properties and rejects mismatched costs or rows',async t=>{
  const directory=await temporary(t),e=exports('Round'),csv=join(directory,'trades.csv'),report=join(directory,'report.xlsx');
  await writeFile(csv,e.csv);await writeFile(report,e.xlsx);
  const r=await analyzeReport(csv,report,plan(),{Length:2},'Round');assert.equal(r.metrics.netProfit,20);assert.equal(r.metrics.closedTrades,1);assert.equal(r.metrics.commission,4);assert.equal(r.metrics.maxDrawdown,9.5);assert.equal(r.metrics.cagr,.3);
  await assert.rejects(()=>analyzeReport(csv,report,{...plan(),settings:{...plan().settings,slippage:9}},{Length:2}),/滑價/);
  await assert.rejects(()=>analyzeReport(csv,report,plan(),{Length:4}),/參數/);
  await assert.rejects(()=>analyzeReport(csv,report,plan(),{},'Old round'),/名稱/);
  await writeFile(csv,e.csv.replace('Exit long','Exit short'));await assert.rejects(()=>analyzeReport(csv,report,plan(),{}),/不一致/);
});
test('AI requests contain no tools, disable response storage and enforce complete structured proposals',async()=>{
  let request;const credentials={model:'test-model',getKey:()=> 'fake-key-not-a-secret'};
  const client=new AiClient(credentials,async(url,opts)=>{request={url,...opts};return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({analysis:'分析',rationale:'理由',source,decision:'continue'})}]}],usage:{input_tokens:10}}));});
  assert.equal((await client.propose({task:'translate',source})).proposal.source,source);
  const payload=JSON.parse(request.body);assert.equal(payload.store,false);assert.equal(payload.tools,undefined);assert.equal(payload.text.format.strict,true);assert.match(request.url,/api.openai.com/);
  const incomplete=new AiClient(credentials,async()=>new Response(JSON.stringify({status:'incomplete'})));
  await assert.rejects(()=>incomplete.propose({}),/未完成/);
});
async function loopFixture(t){
  const directory=await temporary(t),workspace=new Workspace(join(directory,'config'));await workspace.initialize(directory,'Research');await workspace.import('fixture.pine',source);
  const fixture=createChromeFixture();fixture.first.state.context.symbol='COMEX:GC1!';fixture.first.state.context.interval='D';
  vm.runInContext('TVAResearch.adapter.timezone = async () => {}; TVAResearch.adapter.chartOptions = () => {}',fixture.first.sandbox);
  fixture.first.state.exportReport=async(roundId,format)=>{
    const dir=join(directory,'downloads','TradingViewAssistant',roundId);await mkdir(dir,{recursive:true});const filename=join(dir,format==='csv'?'trades.csv':'report.xlsx');
    const e=exports(fixture.first.state.context.strategyName,fixture.first.state.values.Length*10,fixture.first.state.values.Length);await writeFile(filename,format==='csv'?e.csv:e.xlsx);
    return {format,downloadId:1,filename,bytes:(await readFile(filename)).length};
  };
  const handler=bridgeModule.createCommandHandler(fixture.api),bridge={status:()=>({connected:true}),request:(command,args)=>handler(command,args)};
  let calls=0;const ai={propose:async()=>({proposal:{analysis:'比較整批參數',rationale:'調整訊號',source:source+'// next version\n',decision:++calls===1?'continue':'finish'},usage:{input_tokens:1}})};
  const controller=new Controller(workspace,bridge,ai,analyzeReport,10);
  return {controller,fixture,workspace,directory,bridge,calls:()=>calls};
}

test('conversation handoff automatically tests, revises candidates and carries evidence into the next round',async t=>{
  const f=await loopFixture(t),inputs=[];
  const ai={propose:async input=>{
    inputs.push(input);
    if(input.task==='continue_conversation')return {proposal:{analysis:'先測基準',rationale:'沿用最新策略',source,decision:'continue',researchBrief:'規則：日盤逆勢。假設：星期一有優勢，尚未驗證。',nextStep:'測 Length 2',parameterCandidates:[{name:'Length',values:[2]}]},usage:{}};
    return {proposal:{analysis:`第 ${input.version} 版的已驗證分析`,rationale:'比較單一因子',source,decision:input.version===1?'continue':'finish',nextStep:input.version===1?'測 Length 4':'研究完成',parameterCandidates:input.version===1?[{name:'Length',values:[4]}]:[]},usage:{}};
  }};
  const controller=new Controller(f.workspace,f.bridge,ai,analyzeReport,10);
  const text='使用者：測試日盤逆勢\nChatGPT：這是第一版 Pine\n'+source;
  await controller.start({...plan(),sourceMode:'conversation',sourceFile:'',parameters:{},conversationText:text,maxTests:2});
  await until(()=>!controller.busy,10000);
  const r=controller.record;assert.equal(r.status,'completed',r.error);
  assert.deepEqual(r.tests.map(t=>t.parameters.Length),[2,4]);assert.equal(r.analyses.length,2);
  assert.equal(await readFile(r.conversation.path,'utf8'),text);assert.equal(r.plan.conversationText,'');
  assert.equal(inputs[0].task,'continue_conversation');assert.equal(inputs[0].conversation,text);assert.equal(inputs[0].symbol,'COMEX:GC1!');
  assert.equal(inputs[0].maxBatchTests,1);assert.equal(inputs[1].results[0].metrics.netProfit,20);
  assert.match(inputs[2].previous[0].analysis,/已驗證分析/);assert.equal(inputs[2].researchHistory[0].metrics.netProfit,20);
  assert.match(inputs[2].researchBrief,/尚未驗證/);assert.equal(inputs[2].maxBatchTests,0);assert.equal(r.best.score,40);
});

test('URL-only handoff imports the transcript and reaches the bounded backtest loop',async t=>{
  const f=await loopFixture(t),url='https://chatgpt.com/share/00000000-0000-0000-0000-000000000001';let imported;
  const ai={propose:async input=>({proposal:{analysis:'接續對話',rationale:'基準測試',source,decision:input.task==='continue_conversation'?'continue':'finish'},usage:{}})};
  const importer=async(input,signal)=>{imported={input,signal};return {text:'使用者：以最新 Pine 策略繼續研究',url,title:'日盤研究',messages:1};};
  const controller=new Controller(f.workspace,f.bridge,ai,analyzeReport,10,importer);
  await controller.start({...plan(),sourceMode:'conversation',sourceFile:'',conversationUrl:url,parameters:{Length:[2]},maxRounds:1,maxTests:1});
  await until(()=>!controller.busy,10000);
  assert.equal(controller.record.status,'completed',controller.record.error);assert.equal(controller.record.tests.length,1);
  assert.equal(imported.input.conversationUrl,url);assert.equal(imported.signal.aborted,false);assert.equal(controller.record.conversation.url,url);
});

test('conversation rejects excess AI candidates before any backtest and preserves the handoff artifacts',async t=>{
  const f=await loopFixture(t);
  const ai={propose:async()=>({proposal:{analysis:'接續研究',rationale:'候選',source,decision:'continue',parameterCandidates:[{name:'Length',values:[1,2,3]}]},usage:{}})};
  const controller=new Controller(f.workspace,f.bridge,ai,analyzeReport,10);
  await controller.start({...plan(),sourceMode:'conversation',sourceFile:'',conversationText:'測試日盤',parameters:{},maxTests:2});
  await until(()=>!controller.busy);
  assert.equal(controller.record.status,'failed');assert.match(controller.record.error,/超過最大測試數/);
  assert.equal(controller.record.tests.length,0);assert.ok(await readFile(controller.record.conversation.path,'utf8'));
});

test('manual candidates remain authoritative and unavailable URLs stop before AI',async t=>{
  const f=await loopFixture(t);let calls=0;
  const ai={propose:async input=>{calls++;assert.equal(input.allowParameterChanges,false);return {proposal:{analysis:'分析',rationale:'測試',source,decision:'continue',parameterCandidates:[{name:'Length',values:[99]}]},usage:{}};}};
  const controller=new Controller(f.workspace,f.bridge,ai,analyzeReport,10);
  await controller.start({...plan(),sourceMode:'conversation',sourceFile:'',conversationText:'逆勢研究',parameters:{Length:[2]},maxRounds:1,maxTests:1});
  await until(()=>!controller.busy);assert.equal(controller.record.status,'completed',controller.record.error);assert.equal(controller.record.tests[0].parameters.Length,2);
  const imported=new Controller(f.workspace,f.bridge,ai,analyzeReport,10,async()=>{throw new Error('分享網址已失效');});
  await imported.start({...plan(),sourceMode:'conversation',sourceFile:'',conversationUrl:'https://chatgpt.com/share/00000000-0000-0000-0000-000000000001'});
  await until(()=>!imported.busy);assert.equal(imported.record.status,'failed');assert.match(imported.record.error,/已失效/);assert.equal(calls,2);
});

test('conversation requires content, consent and analysis and rejects private URLs before chart writes',async t=>{
  assert.throws(()=>planSchema.parse({...plan(),sourceMode:'conversation',sourceFile:''}),/對話文字或分享網址/);
  assert.throws(()=>planSchema.parse({...plan(),sourceMode:'conversation',conversationText:'策略',analyze:false}),/啟用 AI/);
  assert.throws(()=>planSchema.parse({...plan(),sourceMode:'conversation',conversationText:'策略',aiConsent:false}),/同意/);
  const f=await loopFixture(t);let writes=0;
  const controller=new Controller(f.workspace,{status:()=>({connected:true}),request:async()=>{writes++;return {};}},{propose:async()=>{throw new Error('no AI');}});
  await assert.rejects(()=>controller.start({...plan(),sourceMode:'conversation',conversationUrl:'https://chatgpt.com/c/private'}),/私人/);
  assert.equal(writes,0);
});
test('controller runs two parameter batches through real content runner, preserves versions and calls AI once per batch',async t=>{
  const f=await loopFixture(t);await f.controller.start(plan());await until(()=>!f.controller.busy,10000);
  const r=f.controller.record;assert.equal(r.status,'completed',r.error);assert.equal(r.tests.length,4);assert.equal(f.calls(),2);
  assert.equal(r.tests[0].sourceHash,r.tests[1].sourceHash);assert.notEqual(r.tests[0].sourceHash,r.tests[2].sourceHash);
  assert.deepEqual(r.tests.map(t=>t.parameters.Length),[2,4,2,4]);assert.equal(r.analyses.length,2);assert.equal(r.best.score,40);
  assert.equal((await readdir(join(f.workspace.root,'versions'))).length,2);
  for(const test of r.tests)assert.equal(JSON.parse(await readFile(test.artifacts.metadata,'utf8')).parameters.Length,test.parameters.Length);
});
test('controller stops during a pending deep test, keeps source and never invokes AI on unverified data',async t=>{
  const f=await loopFixture(t);let release;
  f.fixture.first.state.deepWait=()=>new Promise(r=>release=r);
  await f.controller.start(plan());await until(()=>!!release);const stopped=f.controller.stop();release();await stopped;await until(()=>!f.controller.busy,10000);
  assert.equal(f.controller.record.status,'stopped',f.controller.record.error);assert.equal(f.calls(),0);assert.equal(f.controller.record.tests.length,0);
});
test('compiler errors stop before analysis; oversized total batches are rejected before browser writes',async t=>{
  const f=await loopFixture(t);f.fixture.first.state.compileError=true;
  await assert.rejects(()=>f.controller.start({...plan(),maxTests:3}),/總測試上限/);
  await f.controller.start(plan());await until(()=>!f.controller.busy,10000);assert.equal(f.controller.record.status,'failed');assert.equal(f.calls(),0);assert.match(f.controller.record.error,/PINE_COMPILE_ERROR/);
});

test('controller reserves preflight immediately, rejects double starts and stops before AI or artifacts',async t=>{
  const f=await loopFixture(t);let release;
  const bridge={status:()=>({connected:true}),request:async command=>{
    assert.equal(command,'configure_chart');await new Promise(r=>release=r);return {};
  }};
  const controller=new Controller(f.workspace,bridge,{propose:async()=>{throw new Error('AI must not be invoked');}},analyzeReport,10);
  const pending=controller.start(plan());await until(()=>!!release);
  assert.equal(controller.busy,true);await assert.rejects(()=>controller.start(plan()),/已有工作/);
  await controller.stop();release();await assert.rejects(()=>pending,/停止研究/);
  assert.equal(controller.busy,false);assert.equal(controller.record,undefined);
  assert.deepEqual(await readdir(join(f.workspace.root,'runs')),[]);
});

test('recovery retains disconnected work, then releases a confirmed closed chart without replaying it',async t=>{
  const f=await loopFixture(t);let release;
  f.fixture.first.state.deepWait=()=>new Promise(r=>release=r);
  await f.controller.start(plan());await until(()=>!!release);
  const request=f.controller.record.activeSession;
  const failed={status:()=>({connected:false}),request:async()=>{throw Object.assign(new Error('offline'),{code:'BRIDGE_DISCONNECTED'});}};
  const recovered=new Controller(f.workspace,failed,{},analyzeReport,10);await recovered.recover();
  assert.equal(recovered.record.status,'interrupted');assert.equal(recovered.busy,true);
  await assert.rejects(()=>recovered.stop(),/offline/);assert.equal(recovered.busy,true);
  const stopped=f.controller.stop();release();await stopped;await until(()=>!f.controller.busy);
  f.fixture.tabs.delete(1);
  const handler=bridgeModule.createCommandHandler(f.fixture.api),bridge={status:()=>({connected:true}),request:(cmd,args)=>handler(cmd,args)};
  recovered.record.activeSession=request;
  const next=new Controller(f.workspace,bridge,{},analyzeReport,10);
  await writeFile(join(recovered.record.directory,'run.json'),JSON.stringify(recovered.record));await next.recover();
  await next.stop();assert.equal(next.busy,false);assert.equal(next.record.status,'stopped');assert.equal(f.calls(),0);
});
test('HTTP panel rejects unauthenticated and cross-origin writes and never returns an API key',async t=>{
  const directory=await temporary(t),bridge={status:()=>({connected:false}),request:async()=>({})};
  const panel=await startDashboard(bridge,directory,0,{version:1,url:'ws://127.0.0.1:17365/bridge',token:'a'.repeat(64)});
  t.after(()=>new Promise(resolve=>panel.server.close(resolve)));const token=panel.url.split('#')[1];
  assert.equal((await fetch(panel.baseUrl+'/api/state')).status,401);
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(panel.baseUrl+'/api/workspace',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  const response=await fetch(panel.baseUrl+'/api/state',{headers});assert.equal(response.status,200);const data=await response.json();assert.equal(data.ai.hasKey,false);assert.equal(data.ai.key,undefined);
  assert.match((await fetch(panel.baseUrl)).headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
});
test('Windows key storage encrypts a fake key and reloads without returning its value',async t=>{
  if(process.platform!=='win32'){t.skip('DPAPI only on Windows');return;}
  const directory=await temporary(t),credentials=new Credentials(directory),key='fake-test-key-no-account-access';
  await credentials.save('test-model',key);assert.equal(credentials.status().hasKey,true);
  const saved=await readFile(join(directory,'ai.json'),'utf8');assert.ok(!saved.includes(key));
  const next=new Credentials(directory);await next.load();assert.equal(next.getKey(),key);assert.equal(next.status().key,undefined);await next.clear();assert.equal(next.status().hasKey,false);
});
