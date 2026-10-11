import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BridgeError } from '../bridge/server.js';
import { jobSchema, optionsSchema, reportSchema, startSchema, targetSchema, valuesSchema, type CommandBridge } from '../contracts/protocol.js';
import type { ResearchStore } from '../research/store.js';
import { registerResearchTools, RESEARCH_INSTRUCTIONS } from './research.js';

export function createMcpServer(bridge: CommandBridge, research?: ResearchStore): McpServer {
  const server = new McpServer({ name: 'tradingview-assistant', version: '0.2.0' }, { instructions: RESEARCH_INSTRUCTIONS });
  function tool(name: string, description: string, schema: z.ZodObject,
    readOnly: boolean, execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    server.registerTool(name, {
      description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true }
    }, async args => {
      try {
        const data = await execute(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        const data = { code: error instanceof BridgeError ? error.code : 'TOOL_ERROR',
          message: error instanceof Error ? error.message : String(error) };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
      }
    });
  }
  tool('bridge_status', 'Check the local extension bridge connection. This does not test TradingView backtesting.', z.object({}), true,
    async () => bridge.status());
  tool('list_tradingview_tabs', 'List TradingView chart tabs and their tab IDs before choosing an execution target.', z.object({}), true,
    args => bridge.request('list_tabs', args));
  tool('get_strategy_parameters', 'Read inputs from the selected chart strategy settings. Returns expectedContext for subsequent writes. Opens the settings dialog.',
    z.object({ tabId: z.number().int().positive() }), false, args => bridge.request('get_parameters', args));
  tool('start_optimization', 'Start bounded parameter combinations on the exact chart context. Returns a job ID immediately. Query progress and report separately. Original values are detected live.',
    startSchema, false, args => bridge.request('start_optimization', args));
  tool('run_backtest', 'Run one parameter combination on the exact chart context. Returns a job ID immediately; fetch results through get_optimization_report.',
    targetSchema.extend({ parameters: valuesSchema, options: optionsSchema.default(() => optionsSchema.parse({})) }), false,
    args => bridge.request('run_backtest', args));
  tool('get_optimization_job', 'Read a stored job summary. Detects interrupted chart sessions; does not resume work.',
    jobSchema, true, args => bridge.request('get_job', args));
  tool('get_optimization_report', 'Read up to 100 result rows per page, without raw TradingView internals. Includes job summary and best successful result.',
    reportSchema, true, args => bridge.request('get_report', args));
  tool('stop_optimization', 'Request that the specified job stops after the current iteration and restores originals if configured.',
    jobSchema, false, args => bridge.request('stop_optimization', args));
  tool('apply_parameters', 'Apply parameter values to the exact chart context when no optimization is running.',
    targetSchema.extend({ parameters: valuesSchema }), false, args => bridge.request('apply_parameters', args));
  tool('restore_job_parameters', 'Restore the original inputs of a stored job to its original chart session.',
    jobSchema, false, args => bridge.request('restore_parameters', args));
  if (research) registerResearchTools(tool, research);
  return server;
}
