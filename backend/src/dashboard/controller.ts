import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CommandBridge } from '../contracts/protocol.js';
import { ResearchStore } from '../research/store.js';
import { Workspace } from './workspace.js';
import { planSchema, combinations, type Plan } from './config.js';
import { AiClient } from './ai.js';
import { preparePine } from './pine.js';
import { analyzeReport, symbolKey, intervalKey, type Report } from './report.js';

const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const hash=(v:string)=>createHash('sha256').update(v.replace(/\r\n/g,'\n')).digest('hex');
export interface RunRecord {
  id:string;status:string;phase:string;startedAt:string;updatedAt:string;directory:string;plan:Plan;
  tests:Array<{version:number;combination:number;sessionId:string;sourceHash:string;parameters:Record<string,unknown>;report:Report;artifacts:Record<string,string>}>;
  analyses:Array<{version:number;path:string;decision:string}>;usage:unknown[];error?:string;
  activeSession?:{id:string;directory:string};best?:{version:number;combination:number;score:number;sourcePath:string;parameters:Record<string,unknown>};
}
export class Controller {
  record?:RunRecord;
  private running=false;
  private preparing=false;
  private abort?:AbortController;
  private store?:ResearchStore;
  private saving:Promise<void>=Promise.resolve();
  private cancelling?:Promise<void>;
  constructor(private workspace:Workspace,private bridge:CommandBridge,private ai:AiClient,private parseReport=analyzeReport,private pollMs=1000) {}
  get busy(){return this.preparing || this.running || !!this.record?.activeSession;}
  private check(){if(this.abort?.signal.aborted)throw new Error('使用者停止研究。');}
  private save(){
    const next = this.saving.catch(()=>{}).then(()=>this.writeRecord());
    this.saving = next; return next;
  }
  private async writeRecord(){
    if(!this.record)return;
    this.record.updatedAt=new Date().toISOString();
    const file=join(this.record.directory,'run.json');await writeFile(`${file}.tmp`,JSON.stringify(this.record,null,2));await rename(`${file}.tmp`,file);
  }
  async history(){
    if(!this.workspace.root)return [];
    const dir=await this.workspace.safePath('runs');
    const result=[];
    for(const f of await readdir(dir,{withFileTypes:true})) {
      if(!f.isDirectory()||!/^[a-f0-9-]{36}$/.test(f.name))continue;
      try{const path=await this.workspace.safePath(join('runs',f.name,'run.json'));const r=JSON.parse(await readFile(path,'utf8')) as RunRecord;if(r.id!==f.name || !Array.isArray(r.tests) || typeof r.startedAt!=='string')continue;result.push({id:f.name,status:r.status,startedAt:r.startedAt,directory:join(this.workspace.root!, 'runs', f.name),tests:r.tests.length,best:r.best});}catch{/* Incomplete directories have no executable job. */}
    }
    return result.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  }
  async recover(){
    const last=(await this.history())[0];if(!last)return;
    const path=await this.workspace.safePath(join('runs',last.id,'run.json'));
    this.record=JSON.parse(await readFile(path,'utf8'));
    this.record!.directory=await this.workspace.safePath(join('runs',last.id));
    if(['running','preparing','stopping'].includes(this.record!.status)){
      this.record!.status='interrupted';this.record!.phase='服務曾重啟；保留資料，請停止原圖表工作後再建立新研究。';await this.save();
    }
  }
  async start(input:unknown){
    if(this.busy)throw new Error('已有工作執行中或尚未確認停止；請先停止該工作。');
    this.preparing=true;this.abort=new AbortController();
    try{return await this.startPrepared(input);}finally{this.preparing=false;}
  }
  private async startPrepared(input:unknown){
    const plan=planSchema.parse(input), values=combinations(plan.parameters,plan.maxTests);
    if(values.length*plan.maxRounds>plan.maxTests)throw new Error(`最多 ${values.length*plan.maxRounds} 次回測，超過總測試上限 ${plan.maxTests}。`);
    if(!this.workspace.root)throw new Error('請先建立工作資料夾。');
    if(!this.bridge.status().connected)throw new Error('Chrome 擴充套件尚未配對連線。');
    const source=plan.sourceMode==='generate'?'':await this.workspace.source(plan.sourceFile);
    this.check();
    if(plan.sourceMode==='pine')preparePine(source,plan.title,plan.settings);
    await this.bridge.request('configure_chart',{tabId:plan.tabId,timezone:plan.timezone});
    this.check();
    const environment=await this.bridge.request('research_environment',{tabId:plan.tabId});
    this.check();
    const chart=environment.context as any;
    if(!chart || symbolKey(chart.symbol)!==symbolKey(plan.symbol)||intervalKey(chart.interval)!==intervalKey(plan.interval))throw new Error('目標圖表商品或週期不一致；尚未呼叫 AI。');
    const now=new Date().toISOString(), id=randomUUID(), parent=await this.workspace.safePath('runs'), directory=join(parent,id);
    await mkdir(directory);this.record={id,status:'preparing',phase:'準備研究',startedAt:now,updatedAt:now,directory,plan,tests:[],analyses:[],usage:[]};
    this.check();this.running=true;
    try{await this.save();}catch(e){this.running=false;throw e;}
    void this.execute(source,values).catch(async e=>{
      this.record!.status=this.abort!.signal.aborted?'stopped':'failed';this.record!.phase='已停止';this.record!.error=e instanceof Error?e.message:'工作失敗。';
      // A browser action may still be in flight. Keep its session ID until stop is confirmed.
      if(this.record!.activeSession)try{await this.cancelBrowser();}catch{this.record!.status='attention';this.record!.phase='需重新連線並確認原回測已停止。';}
      await this.save();
    }).finally(()=>{this.running=false;});
    return this.record;
  }
  private async phase(value:string){this.check();this.record!.phase=value;await this.save();}
  private async execute(initial:string,values:Record<string,number|boolean|string>[]){
    const r=this.record!,p=r.plan;
    let source=initial;
    if(p.sourceMode!=='pine'){
      await this.phase(p.sourceMode==='translate'?'AI 翻寫策略':'AI 依需求產生策略');
      const response=await this.ai.propose({task:p.sourceMode,source:initial,requirements:p.requirements,title:p.title,settings:p.settings,period:p.period,parameters:p.parameters},this.abort!.signal);
      this.check();r.usage.push(response.usage);
      await writeFile(join(r.directory,'initial-proposal.json'),JSON.stringify(response.proposal,null,2));
      if(!response.proposal.source)throw new Error('AI 沒有產生策略；請查看 initial-proposal.json 的說明。');source=response.proposal.source;
    }
    r.status='running';
    for(let version=1;version<=p.maxRounds;version++){
      source=preparePine(source,p.title,p.settings);
      const versionDir=await this.workspace.safePath('versions'), versionPath=join(versionDir,`${r.id}-v${String(version).padStart(3,'0')}.pine`);
      await writeFile(versionPath,source,{flag:'wx'});const sourceHash=hash(source), batch=[];
      for(let combination=0;combination<values.length;combination++){
        this.check();await this.phase(`第 ${version}/${p.maxRounds} 版，第 ${combination+1}/${values.length} 組：準備圖表`);
        const env=await this.bridge.request('research_environment',{tabId:p.tabId});
        const context=env.context as any;
        if(!context||symbolKey(context.symbol)!==symbolKey(p.symbol)||intervalKey(context.interval)!==intervalKey(p.interval))throw new Error('圖表商品／週期與計畫不一致，請重新準備圖表。');
        const dataDirectory=join(r.directory,`v${String(version).padStart(3,'0')}-test${String(combination+1).padStart(4,'0')}`);
        this.store=new ResearchStore(this.bridge,dataDirectory);
        const created=await this.store.create({tabId:p.tabId,expectedContext:context,period:p.period,goal:p.requirements||'依固定條件比較參數與策略版本',maxRounds:1,timeoutMs:p.timeoutMs,exportXlsx:true,parameters:values[combination],timezone:p.timezone});
        const sessionId=(created.session as any).id;r.activeSession={id:sessionId,directory:dataDirectory};await this.save();
        this.check();await this.store.submit({sessionId,source,rationale:`策略版本 ${version}，參數組合 ${combination+1}；版本雜湊 ${sourceHash}`});
        const deadline=Date.now()+p.timeoutMs+360000;let session:any;
        while(Date.now()<deadline){
          this.check();const state=await this.store.get({sessionId});session=state.session as any;
          if(state.connectionError)throw new Error('瀏覽器橋接中斷；保留目前工作，請重新連線後停止原工作。');
          if(session.status==='awaiting_analysis')break;
          if(['failed','stopped','completed'].includes(session.status))throw new Error(session.stopReason||'回測未產生可分析的結果。');
          r.phase=`第 ${version} 版／第 ${combination+1} 組：${session.rounds.at(-1)?.phase||session.status}`;await this.save();await delay(this.pollMs);
        }
        if(session?.status!=='awaiting_analysis')throw new Error('本輪超時；請確認原圖表工作已停止。');
        const artifacts=session.rounds.at(-1).artifacts;
        await this.phase('核對 CSV／XLSX 與測試條件');
        const report=await this.parseReport(artifacts.trades,artifacts.report,p,values[combination],session.context.strategyName);this.check();
        if(typeof report.metrics[p.objective]!=='number' || !Number.isFinite(report.metrics[p.objective]))throw new Error('報告缺少所選比較指標，不能進行版本排名。');
        await writeFile(join(dataDirectory,'summary.json'),JSON.stringify(report,null,2));
        const test={version,combination:combination+1,sessionId,sourceHash,parameters:values[combination],report,artifacts};r.tests.push(test);batch.push(test);
        await this.store.review({sessionId,round:1,analysis:'程式已核對 CSV、XLSX、口數、費用、商品、週期及參數。AI 在整批完成後分析。',decision:'finish'});
        delete r.activeSession;
        const score=report.metrics[p.objective];
        if(typeof score==='number' && Number.isFinite(score) && (!r.best || (p.objective==='maxDrawdown'?score<r.best.score:score>r.best.score))){
          r.best={version,combination:combination+1,score,sourcePath:versionPath,parameters:values[combination]};
        }
        await this.save();
      }
      await this.comparison();
      if(!p.analyze)break;
      await this.phase(`AI 分析第 ${version} 版整批結果`);
      const response=await this.ai.propose({task:'analyze_and_revise',source,requirements:p.requirements,settings:p.settings,period:p.period,
        symbol:p.symbol,interval:p.interval,version,maxRounds:p.maxRounds,objective:p.objective,parameters:p.parameters,
        results:batch.map(t=>({parameters:t.parameters,metrics:t.report.metrics,annual:t.report.annual,examples:t.report.examples,notes:t.report.notes})),
        previous:r.analyses.map(a=>({version:a.version,decision:a.decision})),instruction:version===p.maxRounds?'已到輪數上限，請分析並 finish；不要要求繼續。':'分析整批參數穩定性；有具體理由才修改策略；沒有合理改進則 finish。'},this.abort!.signal);
      this.check();r.usage.push(response.usage);
      const dir=await this.workspace.safePath('analysis'),path=join(dir,`${r.id}-v${String(version).padStart(3,'0')}.md`);
      await writeFile(path,`${response.proposal.analysis}\n\n修改理由：${response.proposal.rationale}\n`,{flag:'wx'});
      await writeFile(join(r.directory,`proposal-v${version}.json`),JSON.stringify(response.proposal,null,2));
      r.analyses.push({version,path,decision:response.proposal.decision});await this.save();
      if(response.proposal.decision==='finish'||version===p.maxRounds)break;
      if(hash(preparePine(response.proposal.source,p.title,p.settings))===sourceHash)break;
      source=response.proposal.source;
    }
    this.check();r.status='completed';r.phase='研究完成；最佳候選已保存，圖表保留最後測試組合。';await this.comparison();await this.save();
  }
  private async comparison(){
    const r=this.record!,dir=await this.workspace.safePath('analysis');
    await writeFile(join(dir,`${r.id}-comparison.json`),JSON.stringify({objective:r.plan.objective,best:r.best,tests:r.tests.map(t=>({version:t.version,combination:t.combination,sourceHash:t.sourceHash,parameters:t.parameters,metrics:t.report.metrics,artifacts:t.artifacts}))},null,2));
  }
  private cancelBrowser(){
    if(this.cancelling)return this.cancelling;
    this.cancelling=this.cancelActive().finally(()=>{this.cancelling=undefined;});return this.cancelling;
  }
  private async cancelActive(){
    const active=this.record?.activeSession;if(!active)return;
    const directory=await this.workspace.safePath(relative(this.workspace.root!,active.directory));
    const sessionPath=await this.workspace.safePath(relative(this.workspace.root!,join(directory,'research',active.id,'session.json')));
    const saved=JSON.parse(await readFile(sessionPath,'utf8'));
    const inspect=()=>this.bridge.request('inspect_chart',{tabId:saved.tabId});
    const clear=async()=>{delete this.record!.activeSession;await this.save();};
    const store=new ResearchStore(this.bridge,directory);
    try{await store.stop({sessionId:active.id});}
    catch(error){
      // A reloaded or closed tab has discarded its old content-script runner.
      // A disconnected bridge or any running replacement chart must retain the lock.
      const state=await inspect();
      if(state.exists===false || state.chart===false || (state.sessionId!==saved.chartSessionId && state.isRunning===false)){await clear();return;}
      throw error;
    }
    for(let i=0;i<30;i++){
      const value=await store.get({sessionId:active.id});const session=value.session as any;
      if(value.connectionError)throw new Error('無法確認原圖表工作已停止。');
      if(session.status!=='running'){
        const state=await inspect();
        if(state.exists===false || state.chart===false || state.isRunning===false){await clear();return;}
      }
      await delay(this.pollMs);
    }
    throw new Error('原圖表尚未確認停止。');
  }
  async stop(){
    this.abort?.abort();if(this.preparing&&!this.running)return this.record;
    if(this.record){this.record.status='stopping';this.record.phase='正在停止';await this.save();}
    // Let the active polling operation leave the ResearchStore lock before stopping.
    await delay(Math.max(this.pollMs,100));await this.cancelBrowser();
    if(!this.running && this.record){this.record.status='stopped';this.record.phase='已停止';await this.save();}
    return this.record;
  }
}
