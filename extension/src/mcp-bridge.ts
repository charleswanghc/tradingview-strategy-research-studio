import type { DetectedParameter, OptimizationJob, OptimizationParameter, OptimizationOptions, TradingViewContext } from '../../shared/optimization.types';

const SETTINGS_KEY = 'lsrs:mcp-settings';
const STATUS_KEY = 'lsrs:mcp-status';
const RETRY_ALARM = 'lsrs:mcp-reconnect';
type Args = Record<string, any>;
type ChromeApi = typeof chrome;

export class ExtensionCommandError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function isChartUrl(value?: string): boolean {
  try {
    const url = new URL(value || '');
    return ['https:', 'http:'].includes(url.protocol)
      && (url.hostname === 'tradingview.com' || url.hostname.endsWith('.tradingview.com'))
      && url.pathname.startsWith('/chart');
  } catch { return false; }
}

function contextMatches(left: TradingViewContext, right: TradingViewContext): boolean {
  return !!left && !!right && ['strategyName', 'symbol', 'interval', 'url'].every(key => left[key] === right[key]);
}

export function jobSummary(job: OptimizationJob): Record<string, unknown> {
  const successful = job.results.filter(result => result.status === 'success' && result.score !== null);
  const best = successful.reduce<typeof successful[number] | null>((selected, result) =>
    !selected || result.score! > selected.score! ? result : selected, null);
  return { id: job.id, status: job.status, binding: job.binding ?? null, context: job.context,
    createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt ?? null,
    totalIterations: job.totalIterations, plannedIterations: job.plannedIterations,
    completedIterations: job.completedIterations, failedIterations: job.failedIterations,
    currentParameters: job.currentParameters ?? null, objective: job.request.options.objective,
    direction: job.request.options.direction, error: job.error ?? null,
    bestResult: best ? publicResult(best) : null };
}

function publicResult(result: OptimizationJob['results'][number]): Record<string, unknown> {
  const { raw: _raw, ...metrics } = result.metrics;
  return { ...result, metrics };
}

export function createCommandHandler(api: ChromeApi = chrome) {
  async function send(tabId: number, message: Args): Promise<Args> {
    const response = await api.tabs.sendMessage(tabId, message);
    if (!response || ['ERROR', 'ALREADY_RUNNING', 'IGNORED', 'NO_ORIGINALS'].includes(response.status)) {
      throw new ExtensionCommandError(response?.status || 'NO_RESPONSE', response?.error || 'TradingView content script did not accept the command. Refresh the chart after loading the extension.');
    }
    return response;
  }
  async function target(tabId: number, expectedContext?: TradingViewContext) {
    if (!Number.isInteger(tabId) || tabId <= 0) throw new ExtensionCommandError('INVALID_TARGET', 'A positive tabId is required.');
    const tab = await api.tabs.get(tabId);
    if (!isChartUrl(tab.url)) throw new ExtensionCommandError('INVALID_TARGET', 'The target is not a TradingView chart tab.');
    const state = await send(tabId, { type: 'GET_EXECUTION_STATE' });
    if (expectedContext && !contextMatches(state.context, expectedContext)) {
      throw new ExtensionCommandError('CONTEXT_CHANGED', 'Strategy, symbol, timeframe, or chart URL changed. Read parameters again before writing.');
    }
    return state;
  }
  async function getJob(jobId: string): Promise<OptimizationJob> {
    if (typeof jobId !== 'string' || !jobId || jobId.length > 100) throw new ExtensionCommandError('INVALID_JOB', 'Invalid jobId.');
    const key = `lsrs:job:${jobId}`;
    const job = (await api.storage.local.get(key))[key] as OptimizationJob | undefined;
    if (!job) throw new ExtensionCommandError('JOB_NOT_FOUND', 'No stored job exists for this ID.');
    if (job.binding && ['preparing', 'running', 'stopping'].includes(job.status)) {
      let interrupted = false;
      try {
        const state = await target(job.binding.tabId);
        interrupted = state.sessionId !== job.binding.sessionId || state.jobId !== job.id || !state.isRunning;
      } catch { interrupted = true; }
      if (interrupted) {
        job.status = 'failed';
        job.error = 'The original chart session was interrupted. Saved results are retained; automatic resume is unavailable.';
        job.updatedAt = job.completedAt = new Date().toISOString();
        const indexResult = await api.storage.local.get('lsrs:report-index');
        const index = (indexResult['lsrs:report-index'] || []).map((entry: Args) => entry.id === job.id
          ? { ...entry, status: job.status, updatedAt: job.updatedAt } : entry);
        await api.storage.local.set({ [key]: job, 'lsrs:report-index': index });
      }
    }
    return job;
  }
  async function boundJob(jobId: string, checkContext = true) {
    const job = await getJob(jobId);
    if (!job.binding) throw new ExtensionCommandError('JOB_UNBOUND', 'This job has no MCP chart binding.');
    const state = await target(job.binding.tabId, checkContext ? job.context : undefined);
    if (state.sessionId !== job.binding.sessionId) throw new ExtensionCommandError('SESSION_CHANGED', 'The original chart session was reloaded. Read the new context before applying parameters.');
    return { job, state };
  }
  async function detect(tabId: number, expectedContext?: TradingViewContext) {
    const state = await target(tabId, expectedContext);
    const response = await send(tabId, { type: 'GET_PARAMETERS', expectedContext, expectedSessionId: state.sessionId });
    if (expectedContext && !contextMatches(response.context, expectedContext)) throw new ExtensionCommandError('CONTEXT_CHANGED', 'Chart context changed during parameter detection.');
    return { parameters: response.parameters as DetectedParameter[], context: response.context as TradingViewContext, state };
  }
  function normalizeParameters(detected: DetectedParameter[], args: Args, single: boolean): OptimizationParameter[] {
    const requested = single ? Object.entries(args.parameters).map(([name, value]) => ({ name, value })) : args.parameters;
    if (!Array.isArray(requested) || !requested.length || requested.length > 20) throw new ExtensionCommandError('INVALID_PARAMETERS', 'Supply 1 to 20 parameters.');
    const names = new Set<string>();
    return requested.map((item: Args) => {
      if (names.has(item.name)) throw new ExtensionCommandError('INVALID_PARAMETERS', 'Duplicate parameter name.');
      names.add(item.name);
      const original = detected.find(parameter => parameter.name === item.name);
      if (!original) throw new ExtensionCommandError('PARAMETER_NOT_FOUND', `Unknown strategy parameter: ${item.name}`);
      if (!single && original.kind !== item.kind) throw new ExtensionCommandError('INVALID_PARAMETERS', `Parameter kind changed: ${item.name}`);
      let range: Partial<OptimizationParameter> = item;
      if (single) {
        range = original.kind === 'number' ? { start: item.value, end: item.value, step: 1 } : { values: [item.value] };
      }
      if (original.kind === 'number') {
        if (![range.start, range.end, range.step].every(value => typeof value === 'number' && Number.isFinite(value))
          || range.step! <= 0 || range.end! < range.start!
          || Math.floor((range.end! - range.start!) / range.step! + 1e-9) + 1 > 20000) {
          throw new ExtensionCommandError('INVALID_PARAMETERS', `Invalid numeric range for ${item.name}.`);
        }
      } else if (!range.values?.length || range.values.some(value =>
        typeof value !== (original.kind === 'boolean' ? 'boolean' : 'string')
        || (original.kind === 'select' && original.options?.length && !original.options.includes(String(value))))) {
        throw new ExtensionCommandError('INVALID_PARAMETERS', `Invalid values for ${item.name}.`);
      }
      return { ...original, ...range, id: original.id, name: original.name,
        kind: original.kind, currentValue: original.currentValue, enabled: true };
    });
  }

  return async function handle(command: string, args: Args): Promise<Record<string, unknown>> {
    if (!args || typeof args !== 'object') throw new ExtensionCommandError('INVALID_ARGUMENTS', 'Arguments are required.');
    switch (command) {
      case 'inspect_chart': {
        if (!Number.isInteger(args.tabId) || args.tabId <= 0) throw new ExtensionCommandError('INVALID_TARGET', 'A positive tabId is required.');
        const tab = (await api.tabs.query({})).find(t => t.id === args.tabId);
        if (!tab) return { exists: false };
        if (!isChartUrl(tab.url)) return { exists: true, chart: false };
        const state = await target(args.tabId);
        return { exists: true, chart: true, sessionId: state.sessionId, isRunning: state.isRunning, researchRoundId: state.researchRoundId };
      }
      case 'prepare_chart': {
        if (typeof args.symbol !== 'string' || !/^[A-Z0-9_]+:[A-Z0-9!._-]+$/i.test(args.symbol)
          || typeof args.interval !== 'string' || !/^(\d+|\d*[DWM])$/i.test(args.interval)) throw new ExtensionCommandError('INVALID_CHART', 'Invalid symbol or timeframe.');
        const url = new URL('https://www.tradingview.com/chart/');
        url.searchParams.set('symbol', args.symbol); url.searchParams.set('interval', args.interval);
        const tab = await api.tabs.create({ url: url.href, active: true });
        return { tabId: tab.id, url: tab.url || url.href, ready: false };
      }
      case 'configure_chart': {
        const state = await target(args.tabId);
        const response = await send(args.tabId, { type: 'CONFIGURE_RESEARCH_CHART', timezone: args.timezone || 'Etc/UTC', expectedSessionId: state.sessionId });
        return { context: response.context, sessionId: state.sessionId };
      }
      case 'research_environment': {
        const state = await target(args.tabId, args.expectedContext);
        const response = await send(args.tabId, { type: 'RESEARCH_ENVIRONMENT', expectedContext: args.expectedContext, expectedSessionId: state.sessionId });
        return { source: response.source, context: response.context, expectedContext: response.context, sessionId: response.sessionId };
      }
      case 'research_start_round': {
        const state = await target(args.tabId);
        if (state.sessionId !== args.expectedSessionId) throw new ExtensionCommandError('SESSION_CHANGED', 'The research chart was reloaded. Start a new research session.');
        const response = await send(args.tabId, { type: 'START_RESEARCH_ROUND', request: args.request, expectedSessionId: args.expectedSessionId });
        return { round: response.round };
      }
      case 'research_get_round':
      case 'research_stop_round': {
        const state = await target(args.tabId);
        if (state.sessionId !== args.expectedSessionId) throw new ExtensionCommandError('SESSION_CHANGED', 'The research chart session was interrupted; saved local artifacts are retained.');
        const response = await send(args.tabId, { type: command === 'research_get_round' ? 'GET_RESEARCH_ROUND' : 'STOP_RESEARCH_ROUND',
          roundId: args.roundId, expectedSessionId: args.expectedSessionId });
        return command === 'research_get_round' ? { round: response.round } : { status: response.status };
      }
      case 'research_restore_editor': {
        const state = await target(args.tabId);
        if (state.sessionId !== args.expectedSessionId) throw new ExtensionCommandError('SESSION_CHANGED', 'Cannot restore editor source into a different chart session.');
        const response = await send(args.tabId, { type: 'RESEARCH_RESTORE_EDITOR', source: args.source,
          expectedSource: args.expectedSource, expectedSessionId: args.expectedSessionId });
        return { status: response.status, compiled: false };
      }
      case 'list_tabs': {
        const tabs = await api.tabs.query({ url: ['*://*.tradingview.com/chart/*'] });
        return { tabs: tabs.filter(tab => isChartUrl(tab.url)).map(tab => ({ tabId: tab.id, title: tab.title, url: tab.url, active: tab.active })) };
      }
      case 'get_parameters': {
        const detected = await detect(args.tabId);
        return { tabId: args.tabId, sessionId: detected.state.sessionId,
          parameters: detected.parameters, expectedContext: detected.context };
      }
      case 'start_optimization':
      case 'run_backtest': {
        if (!args.expectedContext) throw new ExtensionCommandError('INVALID_TARGET', 'expectedContext from get_strategy_parameters is required.');
        const detected = await detect(args.tabId, args.expectedContext);
        const parameters = normalizeParameters(detected.parameters, args, command === 'run_backtest');
        const options: OptimizationOptions = { objective: 'netProfit', direction: 'maximize', maxIterations: 500,
          timeoutMs: 30000, delayMs: 750, restoreOriginals: true, ...args.options };
        if (command === 'run_backtest') options.maxIterations = 1;
        const response = await send(args.tabId, { type: 'START_OPTIMIZATION', request: { parameters, options },
          expectedContext: args.expectedContext, expectedSessionId: detected.state.sessionId,
          binding: { tabId: args.tabId, sessionId: detected.state.sessionId } });
        if (response.status !== 'STARTED') throw new ExtensionCommandError('START_FAILED', 'Optimization did not start.');
        return { job: jobSummary(response.job) };
      }
      case 'get_job': return { job: jobSummary(await getJob(args.jobId)) };
      case 'get_report': {
        const job = await getJob(args.jobId);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 25;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ExtensionCommandError('INVALID_PAGE', 'Use offset >= 0 and limit from 1 to 100.');
        }
        const results = job.results.filter(result => !args.successfulOnly || result.status === 'success');
        return { job: jobSummary(job), offset, limit, total: results.length,
          nextOffset: offset + limit < results.length ? offset + limit : null,
          results: results.slice(offset, offset + limit).map(publicResult) };
      }
      case 'stop_optimization': {
        const stored = await getJob(args.jobId);
        if (!['preparing', 'running', 'stopping'].includes(stored.status)) return { job: jobSummary(stored) };
        const { job } = await boundJob(args.jobId, false);
        const response = await send(job.binding!.tabId, { type: 'STOP_OPTIMIZATION', jobId: job.id,
          expectedSessionId: job.binding!.sessionId });
        return { jobId: job.id, status: response.status };
      }
      case 'apply_parameters': {
        if (!args.expectedContext) throw new ExtensionCommandError('INVALID_TARGET', 'expectedContext is required.');
        const detected = await detect(args.tabId, args.expectedContext);
        normalizeParameters(detected.parameters, args, true);
        const response = await send(args.tabId, { type: 'APPLY_PARAMETERS', parameters: args.parameters,
          expectedContext: args.expectedContext, expectedSessionId: detected.state.sessionId });
        return { tabId: args.tabId, status: response.status };
      }
      case 'restore_parameters': {
        const { job } = await boundJob(args.jobId);
        const response = await send(job.binding!.tabId, { type: 'APPLY_PARAMETERS', parameters: job.originalParameters,
          expectedContext: job.context, expectedSessionId: job.binding!.sessionId });
        return { jobId: job.id, status: response.status };
      }
      default: throw new ExtensionCommandError('UNKNOWN_COMMAND', 'Unsupported bridge command.');
    }
  };
}

export function installMcpBridge(api: ChromeApi = chrome): void {
  const handle = createCommandHandler(api);
  let socket: WebSocket | null = null;
  let generation = 0;
  let authTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const status = (state: string, error = '') => void api.storage.local.set({
    [STATUS_KEY]: { state, error, updatedAt: new Date().toISOString() }
  }).catch(() => {});

  async function connect(): Promise<void> {
    const current = ++generation;
    clearTimeout(authTimer);
    clearTimeout(retryTimer);
    socket?.close();
    socket = null;
    const settings = (await api.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (current !== generation) return;
    if (!settings?.enabled) { status('disabled'); await api.alarms.clear(RETRY_ALARM); return; }
    let url: URL;
    try {
      url = new URL(settings.url);
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.pathname !== '/bridge'
        || url.search || url.hash || url.username || url.password
        || Number(url.port) < 1024 || Number(url.port) > 65535 || !/^[a-f0-9]{64}$/.test(settings.token)) throw new Error();
    } catch { status('error', '請匯入有效的本機 pairing.json。'); return; }
    api.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    status('connecting');
    const client = new WebSocket(url.href);
    socket = client;
    let ready = false;
    authTimer = setTimeout(() => client.close(), 7000);
    client.onopen = () => client.send(JSON.stringify({ type: 'hello', version: 1,
      token: settings.token, extensionId: api.runtime.id }));
    client.onmessage = event => {
      if (current !== generation) return;
      let request: Args;
      try { request = JSON.parse(event.data); } catch { client.close(); return; }
      if (request.type === 'ready' && request.version === 1) { ready = true; clearTimeout(authTimer); status('connected'); return; }
      if (!ready) { client.close(); return; }
      if (request.type === 'ping') { client.send(JSON.stringify({ type: 'pong' })); return; }
      if (request.type !== 'request' || request.version !== 1 || typeof request.requestId !== 'string') return;
      void handle(request.command, request.args).then(data => reply({ type: 'response', requestId: request.requestId, ok: true, data }))
        .catch(error => reply({ type: 'response', requestId: request.requestId, ok: false,
          error: { code: error instanceof ExtensionCommandError ? error.code : 'EXTENSION_ERROR', message: error instanceof Error ? error.message : String(error) } }));
      function reply(value: Args) {
        if (current === generation && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
      }
    };
    client.onclose = () => {
      if (current !== generation) return;
      clearTimeout(authTimer);
      socket = null;
      status('disconnected', '等待本機 MCP 服務；將自動重新連線。');
      retryTimer = setTimeout(() => void connect(), 5000);
    };
    client.onerror = () => client.close();
  }
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) void connect();
  });
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === RETRY_ALARM && !socket) void connect();
  });
  void connect();
}
