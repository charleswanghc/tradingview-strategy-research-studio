import { z } from 'zod';
import type { OptimizationOptions, OptimizationParameter, TradingViewContext } from '../../../shared/optimization.types.js';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 17365;
export const contextSchema = z.object({
  strategyName: z.string().min(1).max(500),
  symbol: z.string().min(1).max(200),
  interval: z.string().min(1).max(100),
  url: z.url().refine(value => {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol)
      && (url.hostname === 'tradingview.com' || url.hostname.endsWith('.tradingview.com'))
      && url.pathname.startsWith('/chart');
  }, 'Expected a TradingView chart URL.')
}) satisfies z.ZodType<TradingViewContext>;
export const parameterValueSchema = z.union([z.number().finite(), z.boolean(), z.string().max(1000)]);
export const valuesSchema = z.record(z.string().min(1).max(500), parameterValueSchema)
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 20,
    'Supply between 1 and 20 parameters.');
export const parameterSchema = z.object({
  name: z.string().min(1).max(500),
  kind: z.enum(['number', 'boolean', 'select']),
  start: z.number().finite().optional(),
  end: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  values: z.array(parameterValueSchema).min(1).max(1000).optional()
}).superRefine((parameter, ctx) => {
  if (parameter.kind === 'number') {
    const { start, end, step } = parameter;
    if (start === undefined || end === undefined || step === undefined || end < start) {
      ctx.addIssue({ code: 'custom', message: 'Numeric parameters need start <= end and step > 0.' });
    } else if (Math.floor((end - start) / step + 1e-9) + 1 > 20000) {
      ctx.addIssue({ code: 'custom', message: 'One numeric range may contain at most 20,000 values.' });
    }
  } else if (!parameter.values?.length
    || parameter.values.some(value => typeof value !== (parameter.kind === 'boolean' ? 'boolean' : 'string'))) {
    ctx.addIssue({ code: 'custom', message: 'Supply values matching the parameter kind.' });
  }
}) satisfies z.ZodType<Pick<OptimizationParameter, 'name' | 'kind' | 'start' | 'end' | 'step' | 'values'>>;
export const optionsSchema = z.object({
  objective: z.enum(['netProfit', 'netProfitPercent', 'maxDrawdown', 'winRate', 'profitFactor', 'sharpeRatio', 'sortinoRatio', 'totalTrades']).default('netProfit'),
  direction: z.enum(['maximize', 'minimize']).default('maximize'),
  maxIterations: z.number().int().min(1).max(20000).default(500),
  timeoutMs: z.number().int().min(5000).max(180000).default(30000),
  delayMs: z.number().int().min(250).max(10000).default(750),
  restoreOriginals: z.boolean().default(true)
}) satisfies z.ZodType<OptimizationOptions>;
export const targetSchema = z.object({ tabId: z.number().int().positive(), expectedContext: contextSchema });
export const startSchema = targetSchema.extend({
  parameters: z.array(parameterSchema).min(1).max(20)
    .refine(items => new Set(items.map(item => item.name)).size === items.length, 'Parameter names must be unique.'),
  options: optionsSchema.default(() => optionsSchema.parse({}))
});
export const jobSchema = z.object({ jobId: z.string().min(1).max(100) });
export const reportSchema = jobSchema.extend({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
  successfulOnly: z.boolean().default(false)
});
export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('response'), requestId: z.string(), ok: z.literal(true), data: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('response'), requestId: z.string(), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })
]);
export type BridgeCommand = 'list_tabs' | 'get_parameters' | 'start_optimization' | 'run_backtest'
  | 'get_job' | 'get_report' | 'stop_optimization' | 'apply_parameters' | 'restore_parameters'
  | 'research_environment' | 'research_start_round' | 'research_get_round' | 'research_stop_round' | 'research_restore_editor'
  | 'prepare_chart' | 'configure_chart' | 'inspect_chart';
export interface CommandBridge {
  status(): Record<string, unknown>;
  request(command: BridgeCommand, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
