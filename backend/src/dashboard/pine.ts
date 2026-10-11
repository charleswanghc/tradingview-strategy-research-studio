import { strategyTitle } from '../contracts/research.js';
import type { TestSettings } from './config.js';

/** Find the declaration without treating quoted commas, parentheses or comments as syntax. */
export function declaration(source: string): {start:number; end:number; args:string[]} {
  let quote = '', comment = false, start = -1, open = -1, depth = 0, part = 0;
  const args: string[] = [];
  for (let i=0; i<source.length; i++) {
    const c = source[i];
    if (comment) { if (c === '\n') comment = false; continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && source[i+1] === '/') { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (start < 0) {
      if (source.slice(i).match(/^strategy\s*\(/) && !/[\w.]/.test(source[i-1] || '')) { start = i; open = source.indexOf('(', i); i = open; depth = 1; part = i+1; }
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      depth--;
      if (!depth) { args.push(source.slice(part,i).trim()); return {start,end:i+1,args}; }
    } else if (c === ',' && depth === 1) { args.push(source.slice(part,i).trim()); part=i+1; }
  }
  throw new Error('找不到完整的 strategy() 宣告。');
}
export function preparePine(source: string, title: string, settings: TestSettings): string {
  strategyTitle(source);
  if (/\b(?:import|indicator|library)\s*(?:\(|[\w/])/m.test(source.replace(/\/\/[^\n]*/g,''))) throw new Error('研究策略不支援外部 import、indicator 或 library。');
  const d = declaration(source);
  const controlled: Record<string,string> = {
    initial_capital:String(settings.capital), currency:'currency.USD', default_qty_type:'strategy.fixed', default_qty_value:String(settings.quantity),
    commission_type:'strategy.commission.cash_per_contract', commission_value:String(settings.commission), slippage:String(settings.slippage),
    calc_on_every_tick:'false', calc_on_order_fills:'false', process_orders_on_close:'false', use_bar_magnifier:'false', margin_long:'0', margin_short:'0', pyramiding:'0'
  };
  // Keep other named options, but own every setting that affects the shared execution baseline.
  const kept = d.args.slice(1).filter(a => {
    const key = /^\s*(\w+)\s*=/.exec(a.replace(/\/\/[^\n]*/g,''))?.[1];
    if (!key) throw new Error('strategy() 除標題外必須使用具名參數。');
    return key !== 'title' && !(key in controlled);
  });
  const header = `strategy(${JSON.stringify(title)}, ${[...kept,...Object.entries(controlled).map(([k,v])=>`${k}=${v}`)].join(', ')})`;
  return source.slice(0,d.start)+header+source.slice(d.end);
}
