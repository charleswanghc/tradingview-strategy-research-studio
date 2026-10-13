import { z } from 'zod';
import { periodSchema } from '../contracts/research.js';

export const settingsSchema = z.object({
  capital: z.number().positive().max(1e12).default(100000),
  quantity: z.number().int().positive().max(10000).default(1),
  commission: z.number().nonnegative().max(10000).default(0),
  slippage: z.number().int().nonnegative().max(10000).default(0),
  currency: z.literal('USD').default('USD')
});
export type TestSettings = z.infer<typeof settingsSchema>;
export const planSchema = z.object({
  tabId: z.number().int().positive(),
  sourceFile: z.string().max(250).default(''),
  sourceMode: z.enum(['pine', 'translate', 'generate', 'conversation']),
  conversationText: z.string().max(120000).default(''),
  conversationUrl: z.string().max(2000).default(''),
  requirements: z.string().max(12000).default(''),
  title: z.string().min(1).max(120).default('Research Strategy'),
  period: periodSchema, settings: settingsSchema,
  symbol: z.string().min(1).max(100).default('COMEX:GC1!'),
  interval: z.string().min(1).max(20).default('D'),
  timezone: z.string().min(1).max(100).default('Etc/UTC'),
  maxRounds: z.number().int().min(1).max(20).default(3),
  maxTests: z.number().int().min(1).max(1000).default(50),
  timeoutMs: z.number().int().min(30000).max(600000).default(180000),
  objective: z.enum(['netProfit', 'profitFactor', 'maxDrawdown']).default('netProfit'),
  analyze: z.boolean().default(true),
  aiConsent: z.boolean().default(false),
  // Keys are exact input titles in TradingView. The code, not the model, enumerates values.
  parameters: z.record(z.string().min(1).max(200), z.array(z.union([z.number().finite(), z.boolean(), z.string().max(300)])).min(1).max(100)).default({})
}).superRefine((p, c) => {
  if (Object.keys(p.parameters).length > 20) c.addIssue({code:'custom', message:'最多 20 個參數。'});
  if (['pine','translate'].includes(p.sourceMode) && !p.sourceFile) c.addIssue({code:'custom', message:'請選擇策略來源檔案。'});
  if (p.sourceMode === 'generate' && !p.requirements.trim()) c.addIssue({code:'custom', message:'請填寫新策略需求。'});
  if (p.sourceMode === 'conversation' && !p.conversationText.trim() && !p.conversationUrl.trim()) c.addIssue({code:'custom', message:'請貼上 ChatGPT 對話文字或分享網址。'});
  if (p.sourceMode === 'conversation' && !p.analyze) c.addIssue({code:'custom', message:'接續對話需要啟用 AI 分析與後續修訂。'});
  if ((p.analyze || p.sourceMode !== 'pine') && !p.aiConsent) c.addIssue({code:'custom', message:'請確認同意將本次策略與回測摘要交給 OpenAI API 處理。'});
});
export type Plan = z.infer<typeof planSchema>;

export function combinations(parameters: Plan['parameters'], limit: number): Record<string, number | boolean | string>[] {
  const entries = Object.entries(parameters).map(([key, values]) => [key, [...new Set(values)]] as const);
  const count = entries.reduce((n, [, values]) => n * values.length, 1);
  if (!Number.isSafeInteger(count) || count > limit) throw new Error(`參數共有 ${count} 組，超過最大測試數 ${limit}；請縮小範圍。`);
  return Array.from({length: count}, (_, i) => {
    const result: Record<string, number | boolean | string> = {};
    for (const [key, values] of [...entries].reverse()) { result[key] = values[i % values.length]; i = Math.floor(i / values.length); }
    return result;
  });
}
