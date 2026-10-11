import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { Plan } from './config.js';

type Cell = string | number;
const list = (v:any):any[] => v===undefined ? [] : Array.isArray(v) ? v : [v];
const xml = new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false,trimValues:false});
const key = (v:unknown) => String(v??'').trim().toLowerCase().replace(/[\s_]/g,'');
export const symbolKey = (v:string) => v.toUpperCase().replace(/_DL(?=:)/,'').replace(/\s/g,'');
export const intervalKey = (v:string) => {
  const s=v.toLowerCase().replace(/\s/g,'');
  const hour=/^(\d+)hours?$/.exec(s),minute=/^(\d+)(?:minutes?|min)$/.exec(s);
  if(hour)return String(Number(hour[1])*60);if(minute)return minute[1];
  return s.replace(/^1?(day|d)$/,'d').replace(/^1?(week|w)$/,'w');
};
function number(v:unknown):number {
  const text=String(v??'').replace(/[,%\s\u2212]/g, c=>c==='\u2212'?'-':'');
  if(!text || !/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(text)) throw new Error(`報告欄位不是有效數字：${String(v).slice(0,100)}`);
  const n=Number(text); if(!Number.isFinite(n)) throw new Error('報告有非有限數值。'); return n;
}
function numericCell(v:unknown) { try {return number(v);} catch {return null;} }
function near(a:number,b:number,label:string,tolerance=0.011) { if(Math.abs(a-b)>tolerance) throw new Error(`報告核對失敗：${label}（${a}／${b}）`); }
function textValue(v:any):string { if(v===undefined)return ''; if(typeof v!=='object')return String(v); return list(v.r).map(r=>textValue(r.t)).join('') || textValue(v.t ?? v['#text']); }

export function workbook(bytes:Uint8Array):Record<string,Cell[][]> {
  let expanded=0;
  const entries=unzipSync(bytes,{filter:file=>{
    expanded+=file.originalSize;
    if(expanded>256*1024*1024 || file.originalSize>32*1024*1024) throw new Error('XLSX 解壓縮大小超過限制。');
    return /^(xl\/|\[Content_Types\])/.test(file.name);
  }});
  function doc(name:string) {
    const data=entries[name]; if(!data) throw new Error(`XLSX 缺少 ${name}`);
    const value=new TextDecoder().decode(data); if(/<!DOCTYPE|<!ENTITY/i.test(value))throw new Error('XLSX 不支援 XML 實體宣告。');
    return xml.parse(value);
  }
  const shared=entries['xl/sharedStrings.xml'] ? list(doc('xl/sharedStrings.xml').sst?.si).map(textValue) : [];
  const relations = Object.fromEntries(list(doc('xl/_rels/workbook.xml.rels').Relationships?.Relationship).map(r=>[r['@_Id'],r['@_Target']]));
  const output:Record<string,Cell[][]>={};
  for(const sheet of list(doc('xl/workbook.xml').workbook?.sheets?.sheet)) {
    const target=relations[sheet['@_r:id']];
    if(typeof target!=='string'||target.includes('..'))throw new Error('XLSX 工作表路徑無效。');
    const path=target.startsWith('/')?target.slice(1):`xl/${target}`;
    output[sheet['@_name']]=list(doc(path).worksheet?.sheetData?.row).map(row=>{
      const cells:Cell[]=[];
      for(const c of list(row.c)) {
        const letters=/^[A-Z]+/.exec(c['@_r'] || '')?.[0]; if(!letters)throw new Error('XLSX 儲存格缺少位置。');
        const index=[...letters].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1;
        if(index>255)throw new Error('XLSX 工作表超過 256 欄。');
        let v:Cell='';
        if(c['@_t']==='s') { v=shared[Number(c.v)]; if(v===undefined)throw new Error('XLSX 文字索引不存在。'); }
        else if(c['@_t']==='inlineStr')v=textValue(c.is);
        else if(c.v!==undefined)v=c['@_t']==='str'?String(c.v):numericCell(c.v)??String(c.v);
        cells[index]=v;
      }
      return Array.from({length:cells.length},(_,i)=>cells[i]??'');
    });
  }
  return output;
}

export async function analyzeReport(csvPath:string,xlsxPath:string,plan:Plan,parameters:Record<string,unknown>,expectedTitle?:string) {
  const [csv,xlsx]=await Promise.all([readFile(csvPath),readFile(xlsxPath)]);
  if(csv.length>100*1024*1024||xlsx.length>100*1024*1024)throw new Error('報告超過 100 MiB。');
  const rows=parse(csv,{bom:true,skip_empty_lines:true,max_record_size:1024*1024}) as string[][];
  if(rows.length>2000001)throw new Error('CSV 超過兩百萬列。');
  const sheets=workbook(xlsx), headers=rows.shift(); if(!headers)throw new Error('CSV 沒有標題。');
  const sheet=(name:string)=>{const value=Object.entries(sheets).find(([k])=>key(k)===key(name))?.[1];if(!value)throw new Error(`目前支援英文 TradingView 匯出；缺少 ${name} 工作表。`);return value;};
  const trades=sheet('Trades'), props=Object.fromEntries(sheet('Properties').filter(r=>r[0]).map(r=>[key(r[0]),r[1]]));
  const perf=Object.fromEntries(sheet('Performance').filter(r=>r[0]).map(r=>[key(r[0]),r.slice(1)]));
  const risk=Object.fromEntries(sheet('Risk-adjusted performance').filter(r=>r[0]).map(r=>[key(r[0]),r.slice(1)]));
  if(trades.length!==rows.length+1 || JSON.stringify(trades[0])!==JSON.stringify(headers))throw new Error('CSV 與 XLSX 的交易欄位或列數不一致。');
  const column=(names:string[])=>{const i=headers.findIndex(h=>names.some(n=>key(n)===key(h)));if(i<0)throw new Error(`交易 CSV 缺少 ${names[0]}。`);return i;};
  const id=column(['Trade number','Trade #']), type=column(['Type']), date=column(['Date and time']), qty=column(['Size (qty)','Contracts']), pnl=column(['Net PnL USD']), fee=column(['Commission USD']);
  const normalizeDate=(s:string)=>s.trim().replace('T',' ').replace(/Z$/,'').replace(/ 00:00(?::00)?$/,'').replace(/:00$/,'');
  for(let i=0;i<rows.length;i++) {
    if(rows[i].length!==headers.length)throw new Error('CSV 列欄位數量不一致。');
    for(let c=0;c<headers.length;c++) {
      const a=rows[i][c], b=trades[i+1][c]??'';
      if(c===date && typeof b==='number') {
        const value=new Date(Math.round((b-25569)*86400000)).toISOString().replace('.000Z','');
        if(normalizeDate(a)!==normalizeDate(value))throw new Error(`CSV／XLSX 第 ${i+1} 列日期不一致。`);
      } else if(typeof b==='number')near(number(a),b,`第 ${i+1} 列 ${headers[c]}`,0.00001);
      else if(normalizeDate(a)!==normalizeDate(String(b)))throw new Error(`CSV／XLSX 第 ${i+1} 列 ${headers[c]} 不一致。`);
    }
    near(number(rows[i][qty]),plan.settings.quantity,'每筆交易口數',0.000001);
  }
  function property(name:string) { if(!(key(name) in props))throw new Error(`報告缺少 ${name} 屬性，不能核對測試條件。`);return props[key(name)]; }
  if(expectedTitle && property('Name')!==expectedTitle)throw new Error('XLSX 策略名稱與本輪部署版本不一致。');
  if(property('Currency')!=='USD')throw new Error('報告貨幣不是 USD。');
  if(symbolKey(String(property('Symbol')))!==symbolKey(plan.symbol)||intervalKey(String(property('Timeframe')))!==intervalKey(plan.interval))throw new Error('報告商品或週期與測試設定不一致。');
  if(key(property('Chart type'))!=='candles')throw new Error('只支援標準 K 線圖，請停用 Heikin Ashi 等合成圖表。');
  near(number(property('Initial capital')),plan.settings.capital,'初始資金');
  near(number(String(property('Default order size')).split(' ')[0]),plan.settings.quantity,'預設口數');
  if(!/contracts?/i.test(String(property('Default order size'))))throw new Error('預設下單必須是固定口數。');
  near(number(property('Commission')),plan.settings.commission,'每合約手續費');
  near(number(String(property('Slippage')).split(' ')[0]),plan.settings.slippage,'滑價 ticks');
  if(number(String(property('Pyramiding')).split(' ')[0])!==0 || property('Long leverage')!=='Infinity' || property('Short leverage')!=='Infinity')throw new Error('報告加碼／保證金設定與固定條件不一致。');
  if(property('Script execution')!=='On bar close' || property('Bar detalization')!=='Default (4 ticks per bar)')throw new Error('報告撮合／計算模式與固定條件不一致。');
  const actualRange=String(property('Backtesting range')).split(/\s+[—–]\s+/);
  const dates=actualRange.map(d=>{const timestamp=Date.parse(`${d} UTC`);if(!Number.isFinite(timestamp))throw new Error('無法辨識報告回測日期。');return new Date(timestamp).toISOString().slice(0,10);});
  if(dates.length!==2 || dates[0]>dates[1] || dates[0]<plan.period.start || dates[1]>plan.period.end)throw new Error('XLSX 回測資料期間超出本次設定或順序錯誤。');
  for(const [name,value]of Object.entries(parameters)) {
    const actual=property(name);
    if(typeof value==='number')near(number(actual),value,`參數 ${name}`,0.000001);
    else if(typeof value==='boolean') {if(!['true','false','on','off','1','0'].includes(String(actual).toLowerCase()) || value!==['true','on','1'].includes(String(actual).toLowerCase()))throw new Error(`報告參數 ${name} 不一致。`);}
    else if(String(actual)!==value)throw new Error(`報告參數 ${name} 不一致。`);
  }
  const groups=new Map<string,string[][]>(); for(const r of rows){const g=groups.get(r[id])||[];g.push(r);groups.set(r[id],g);}
  const closed:string[][]=[],opened:string[][]=[];
  for(const [n,g]of groups) {
    if(g.length!==2||g.filter(r=>/^entry (long|short)$/i.test(r[type])).length!==1||g.filter(r=>/^exit (long|short)$/i.test(r[type])).length!==1)throw new Error(`交易 ${n} 無法配對；目前不支援分批出場或不同格式。`);
    near(number(g[0][pnl]),number(g[1][pnl]),`交易 ${n} 進出場損益`);
    const exit=g.find(r=>/^exit /i.test(r[type]))!;
    near(number(exit[fee]),plan.settings.commission*plan.settings.quantity*(/^open$/i.test(exit[date])?1:2),`交易 ${n} 每合約費用`);
    (/^open$/i.test(exit[date])?opened:closed).push(exit);
  }
  const profits=closed.map(r=>number(r[pnl])), sum=(xs:number[])=>xs.reduce((a,b)=>a+b,0);
  const closedNet=sum(profits), grossProfit=sum(profits.filter(p=>p>0)), grossLoss=-sum(profits.filter(p=>p<0));
  const commission=sum([...closed,...opened].map(r=>number(r[fee]))), openCommission=sum(opened.map(r=>number(r[fee])));
  const metric=(table:typeof perf,name:string)=>{const v=table[key(name)]?.[0];return numericCell(v);};
  const netProfit=metric(perf,'Net profit'); if(netProfit===null)throw new Error('XLSX 缺少 Net profit。');
  near(netProfit,closedNet-openCommission,'已平倉淨利扣除未平倉進場費用');
  for(const [name,value]of [['Gross profit',grossProfit],['Gross loss',grossLoss+openCommission],['Commission paid',commission]] as const){const reported=metric(perf,name);if(reported===null)throw new Error(`報告缺少 ${name}。`);near(reported,value,name);}
  const annual:Record<string,{trades:number;wins:number;netPnl:number}>={};
  for(const r of closed){const year=r[date].slice(0,4);const a=annual[year] ||= {trades:0,wins:0,netPnl:0};a.trades++;a.wins+=number(r[pnl])>0?1:0;a.netPnl+=number(r[pnl]);}
  const pf=metric(risk,'Profit factor'), dd=metric(perf,'Max drawdown (intrabar)')??metric(perf,'Max equity drawdown (intrabar)')??metric(perf,'Max drawdown');
  const openPnl=metric(perf,'Open PnL');
  const examples=[...closed].sort((a,b)=>number(b[pnl])-number(a[pnl]));
  const sample=(r:string[])=>({trade:r[id],side:r[type],exit:r[date],netPnl:number(r[pnl])});
  return {verified:true,parameters,properties:props,metrics:{netProfit,closedNetProfit:closedNet,openPnl,totalPnl:openPnl===null?null:netProfit+openPnl,
    closedTrades:closed.length,openTrades:opened.length,winRate:closed.length?profits.filter(p=>p>0).length/closed.length*100:null,
    grossProfit,grossLoss,commission,profitFactor:pf,maxDrawdown:dd,
    top10Profit:sum([...profits].sort((a,b)=>b-a).slice(0,10)),cagr:numericCell(perf[key('Annualized return (CAGR)')]?.[1]),
    maxDrawdownPercent:numericCell(perf[key('Max drawdown (intrabar)')]?.[1]),
    sharpeRatio:metric(risk,'Sharpe ratio'),sortinoRatio:metric(risk,'Sortino ratio')},annual,examples:{largestWins:examples.slice(0,5).map(sample),largestLosses:examples.slice(-5).reverse().map(sample)},
    rows:rows.length,hashes:{csv:createHash('sha256').update(csv).digest('hex'),xlsx:createHash('sha256').update(xlsx).digest('hex')},
    performance:perf,risk,
    notes:[`XLSX 實際可回測資料期間為 ${dates[0]} 至 ${dates[1]}；要求期間為 ${plan.period.start} 至 ${plan.period.end}，分析須以實際資料範圍為準。`,'CSV 進出場列以交易編號配對，只計算一次損益。','盤中回撤保留 XLSX 原生數值；不從已平倉損益推算。',...(plan.sourceMode==='translate'?['語義一致性尚需 MultiCharts 原生報告另行比對。']:[])]};
}
export type Report = Awaited<ReturnType<typeof analyzeReport>>;
