type ParameterKind = import('../../shared/optimization.types').ParameterKind;
type ParameterValue = import('../../shared/optimization.types').ParameterValue;
type ObjectiveMetric = import('../../shared/optimization.types').ObjectiveMetric;
type ObjectiveDirection = import('../../shared/optimization.types').ObjectiveDirection;
type OptimizationJobStatus = import('../../shared/optimization.types').OptimizationJobStatus;
type OptimizationParameter = import('../../shared/optimization.types').OptimizationParameter;
type OptimizationRequest = import('../../shared/optimization.types').OptimizationRequest;
type TradingViewContext = import('../../shared/optimization.types').TradingViewContext;
type BacktestMetrics = import('../../shared/optimization.types').BacktestMetrics;
type OptimizationResult = import('../../shared/optimization.types').OptimizationResult;
type OptimizationJob = import('../../shared/optimization.types').OptimizationJob;
type DetectedParameter = import('../../shared/optimization.types').DetectedParameter;
type TradingViewBinding = import('../../shared/optimization.types').TradingViewBinding;

interface ParameterControl {
  label: string;
  kind: ParameterKind;
  element: HTMLElement;
  currentValue: ParameterValue;
  options?: string[];
}

const REPORT_INDEX_KEY = 'lsrs:report-index';
const ACTIVE_JOB_KEY = 'lsrs:active-job';
const JOB_PREFIX = 'lsrs:job:';
const MAXIMUM_HARD_ITERATIONS = 20000;
const POLL_INTERVAL_MS = 250;

let isRunning = false;
let stopRequested = false;
let activeJob: OptimizationJob | null = null;
let originalParameters: Record<string, ParameterValue> = {};
let overlayElement: HTMLElement | null = null;
const contentSessionId = crypto.randomUUID();
let parameterOperationInProgress = false;
let researchState: import('../../shared/research.types').ResearchRoundState | null = null;
let researchStopRequested = false;

injectPageContext();
console.info('[LSRS] TradingView optimizer content script ready.');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then(response => sendResponse(response))
    .catch(error => {
      console.error('[LSRS] Message failed:', error);
      sendResponse({
        status: 'ERROR',
        error: error instanceof Error ? error.message : String(error)
      });
    });
  return true;
});

async function handleMessage(message: any): Promise<any> {
  if (message?.type === 'GET_EXECUTION_STATE') {
    return { status: 'SUCCESS', sessionId: contentSessionId, context: getTradingViewContext(),
      isRunning, jobId: researchState?.status === 'running' ? null : activeJob?.id ?? null,
      researchRoundId: researchState?.roundId ?? null };
  }
  assertMessageTarget(message);
  if (message?.type === 'GET_RESEARCH_ROUND') {
    const saved = (await chrome.storage.local.get(`lsrs:research:${message.roundId}`))[`lsrs:research:${message.roundId}`];
    if (!saved) throw new Error('Research round not found.');
    if (saved.status === 'running' && (!isRunning || researchState?.roundId !== saved.roundId || researchState.status !== 'running')) {
      saved.status = 'failed'; saved.phase = 'failed'; saved.updatedAt = new Date().toISOString();
      saved.error = 'The research runner was interrupted. Saved browser and local artifacts are retained.';
      await chrome.storage.local.set({ [`lsrs:research:${saved.roundId}`]: saved });
    }
    return { status: 'SUCCESS', round: saved };
  }
  if (message?.type === 'STOP_RESEARCH_ROUND') {
    if (researchState?.roundId !== message.roundId) throw new Error('This research round is not active in the chart session.');
    researchStopRequested = true;
    void chrome.runtime.sendMessage({ type: 'RESEARCH_CANCEL_EXPORT', roundId: message.roundId });
    return { status: researchState.status === 'running' ? 'STOPPING' : 'NOT_RUNNING' };
  }
  if (message?.type === 'TRIGGER_RESEARCH_EXPORT') {
    if (researchState?.roundId !== message.roundId || researchState.status !== 'running'
      || !researchState.phase.startsWith('exporting_') || researchStopRequested) throw new Error('Research export is not active.');
    await TVAResearch.adapter.clickExport(message.format);
    return { status: 'TRIGGERED' };
  }
  if (message?.type === 'STOP_OPTIMIZATION') {
    if (researchState?.status === 'running') return { status: 'ALREADY_RUNNING', error: 'Use the chart research stop button or stop_strategy_research to stop this Pine research round.' };
    if (message.jobId && activeJob?.id !== message.jobId) throw new Error('The requested job is not running in this chart session.');
    if (!isRunning) return { status: 'NOT_RUNNING' };
    stopRequested = true;
    if (activeJob) {
      activeJob.status = 'stopping';
      activeJob.updatedAt = new Date().toISOString();
      await persistJob(activeJob);
      notifyJob(activeJob);
    }
    return { status: 'STOPPING' };
  }
  if (!['GET_PARAMETERS', 'START_OPTIMIZATION', 'RESTORE_DEFAULTS', 'APPLY_PARAMETERS', 'RESEARCH_ENVIRONMENT', 'START_RESEARCH_ROUND', 'RESEARCH_RESTORE_EDITOR', 'CONFIGURE_RESEARCH_CHART'].includes(message?.type)) {
    return { status: 'IGNORED' };
  }
  if (isRunning || parameterOperationInProgress) {
    return { status: 'ALREADY_RUNNING', error: 'Wait for the current parameter operation or stop the running optimization.' };
  }
  parameterOperationInProgress = true;
  try {
    switch (message.type) {
    case 'CONFIGURE_RESEARCH_CHART':
      await TVAResearch.adapter.timezone(message.timezone, true);
      TVAResearch.adapter.chartOptions(getTradingViewContext().symbol);
      return { status: 'SUCCESS', context: getTradingViewContext() };
    case 'RESEARCH_ENVIRONMENT':
      return { status: 'SUCCESS', source: await TVAResearch.adapter.readEditor(), sessionId: contentSessionId, context: getTradingViewContext() };
    case 'RESEARCH_RESTORE_EDITOR':
      await TVAResearch.adapter.writeEditor(message.source, message.expectedSource);
      return { status: 'RESTORED', compiled: false };
    case 'START_RESEARCH_ROUND': {
      const request = message.request as import('../../shared/research.types').ResearchRoundRequest;
      if (!request || !/^[a-f0-9-]{36}$/.test(request.roundId) || typeof request.source !== 'string'
        || request.source.length > 200000 || typeof request.expectedEditorSource !== 'string'
        || request.expectedEditorSource.length > 200000 || !request.source.length
        || typeof request.strategyTitle !== 'string' || request.strategyTitle.length > 200
        || !/^\d{4}-\d{2}-\d{2}$/.test(request.period?.start) || !/^\d{4}-\d{2}-\d{2}$/.test(request.period?.end)
        || request.period.start >= request.period.end || !Number.isInteger(request.timeoutMs)
        || request.timeoutMs < 30000 || request.timeoutMs > 600000
        || request.expectedSessionId !== contentSessionId) throw new Error('Invalid research round request.');
      isRunning = true; researchStopRequested = false;
      const state: import('../../shared/research.types').ResearchRoundState = { roundId: request.roundId,
        sessionId: contentSessionId, status: 'running', phase: 'preparing', startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), context: getTradingViewContext(), period: request.period,
        editorWritten: false, downloads: [] };
      researchState = state;
      const persist = () => {
        TVAResearch.progress(state, () => { researchStopRequested = true; void chrome.runtime.sendMessage({ type: 'RESEARCH_CANCEL_EXPORT', roundId: state.roundId }); });
        return chrome.storage.local.set({ [`lsrs:research:${state.roundId}`]: state });
      };
      try { await persist(); }
      catch (error) { isRunning = false; throw error; }
      setTimeout(() => void TVAResearch.execute(request, state, persist, () => researchStopRequested)
        .catch(error => console.error('[LSRS] Research finalization failed:', error))
        .finally(() => { isRunning = false; researchStopRequested = false; }), 0);
      return { status: 'STARTED', round: state };
    }
    case 'GET_PARAMETERS': {
      const parameters = await getStrategyParameters();
      return {
        status: 'SUCCESS',
        parameters,
        context: getTradingViewContext()
      };
    }

    case 'START_OPTIMIZATION': {
      const request = validateRequest(message.request);
      isRunning = true;
      stopRequested = false;
      try {
        const job = await createJob(request, message.binding);
        setTimeout(() => void runOptimization(job).catch(error => console.error('[LSRS] Job finalization failed:', error)), 0);
        return { status: 'STARTED', job };
      } catch (error) {
        isRunning = false;
        throw error;
      }
    }

    case 'RESTORE_DEFAULTS': {
      const parameters = Object.keys(originalParameters).length
        ? originalParameters
        : activeJob?.originalParameters ?? {};
      if (!Object.keys(parameters).length) {
        return { status: 'NO_ORIGINALS' };
      }
      await applyParameterValues(parameters);
      return { status: 'RESTORE_SUCCESS' };
    }

    case 'APPLY_PARAMETERS':
      await applyParameterValues(message.parameters ?? {});
      return { status: 'APPLIED' };

    default:
      return { status: 'IGNORED' };
    }
  } finally {
    parameterOperationInProgress = false;
  }
}

function assertMessageTarget(message: any): void {
  if (message?.expectedSessionId && message.expectedSessionId !== contentSessionId) {
    throw new Error('The TradingView chart session changed. Read parameters again.');
  }
  if (message?.binding && (message.binding.sessionId !== contentSessionId
    || !Number.isInteger(message.binding.tabId) || message.binding.tabId <= 0)) {
    throw new Error('Invalid MCP chart binding.');
  }
  if (message?.expectedContext) assertChartContext(message.expectedContext);
}

function assertChartContext(expected: TradingViewContext): void {
  const current = getTradingViewContext();
  if (!expected || !(['strategyName', 'symbol', 'interval', 'url'] as const).every(key => current[key] === expected[key])) {
    throw new Error('TradingView strategy, symbol, timeframe, or chart URL changed.');
  }
}

function injectPageContext(): void {
  const inject = () => {
    if (document.getElementById('tva-page-context')) return;
    const script = document.createElement('script');
    script.id = 'tva-page-context';
    script.src = chrome.runtime.getURL('page-context.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  } else {
    inject();
  }
}

function validateRequest(request: OptimizationRequest): OptimizationRequest {
  if (!request || !Array.isArray(request.parameters)) {
    throw new Error('Optimization parameters are missing.');
  }

  const parameters = request.parameters.filter(parameter => parameter.enabled);
  if (!parameters.length) throw new Error('Enable at least one parameter.');
  if (parameters.length > 20 || new Set(parameters.map(parameter => parameter.name)).size !== parameters.length) {
    throw new Error('Use at most 20 parameters with unique names.');
  }
  if (!request.options || !['netProfit', 'netProfitPercent', 'maxDrawdown', 'winRate', 'profitFactor', 'sharpeRatio', 'sortinoRatio', 'totalTrades'].includes(request.options.objective)
    || !['maximize', 'minimize'].includes(request.options.direction)) throw new Error('Invalid optimization objective or direction.');

  for (const parameter of parameters) {
    if (!parameter.name.trim()) throw new Error('Every parameter needs a name.');
    if (parameter.kind === 'number') {
      const start = Number(parameter.start);
      const end = Number(parameter.end);
      const step = Number(parameter.step);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0 || end < start
        || Math.floor((end - start) / step + 1e-9) + 1 > MAXIMUM_HARD_ITERATIONS) {
        throw new Error(`Invalid numeric range for "${parameter.name}".`);
      }
    } else if (!['boolean', 'select'].includes(parameter.kind) || !parameter.values?.length
      || parameter.values.length > 1000
      || parameter.values.some(value => typeof value !== (parameter.kind === 'boolean' ? 'boolean' : 'string'))) {
      throw new Error(`Choose at least one value for "${parameter.name}".`);
    }
  }

  request.options.maxIterations = Math.floor(clamp(
    Number(request.options.maxIterations) || 1,
    1,
    MAXIMUM_HARD_ITERATIONS
  ));
  request.options.timeoutMs = clamp(Number(request.options.timeoutMs) || 30000, 5000, 180000);
  request.options.delayMs = clamp(Number(request.options.delayMs) || 750, 250, 10000);
  return request;
}

async function createJob(request: OptimizationRequest, binding?: TradingViewBinding): Promise<OptimizationJob> {
  const valueSets = buildValueSets(request.parameters);
  const fullIterationCount = valueSets.reduce((total, set) => total * set.values.length, 1);
  if (!Number.isSafeInteger(fullIterationCount)) throw new Error('The parameter space is too large. Reduce the ranges.');
  const totalIterations = Math.min(fullIterationCount, request.options.maxIterations);
  const now = new Date().toISOString();

  originalParameters = Object.fromEntries(
    request.parameters.map(parameter => [parameter.name, parameter.currentValue])
  );

  const job: OptimizationJob = {
    binding,
    id: createJobId(),
    status: 'preparing',
    createdAt: now,
    updatedAt: now,
    context: getTradingViewContext(),
    request,
    totalIterations,
    plannedIterations: fullIterationCount,
    completedIterations: 0,
    failedIterations: 0,
    results: [],
    originalParameters: { ...originalParameters }
  };

  activeJob = job;
  await persistJob(job, true);
  notifyJob(job);
  return job;
}

async function runOptimization(job: OptimizationJob): Promise<void> {
  isRunning = true;
  activeJob = job;
  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  try {
    showOverlay(job);
    await persistJob(job);
    notifyJob(job);
    const valueSets = buildValueSets(job.request.parameters);

    for (let index = 0; index < job.totalIterations; index += 1) {
      if (stopRequested) break;
      if (job.binding) assertChartContext(job.context);

      const parameters = combinationAt(index, valueSets);
      const iterationStart = performance.now();
      job.currentParameters = parameters;
      updateOverlay(job, parameters);
      notifyJob(job);

      let result: OptimizationResult;
      try {
        const beforeFingerprint = getReportFingerprint();
        await openSettingsPanel();
        await setParametersInOpenDialog(parameters);
        await applySettings();
        await waitForCalculation(beforeFingerprint, job.request.options.timeoutMs);
        if (job.binding) assertChartContext(job.context);

        const pageError = await closeTradingViewError();
        if (pageError) throw new Error(pageError);

        const metrics = await getBacktestMetrics();
        result = {
          iteration: index + 1,
          parameters,
          metrics,
          score: calculateScore(metrics, job.request.options.objective, job.request.options.direction),
          durationMs: Math.round(performance.now() - iterationStart),
          status: 'success',
          createdAt: new Date().toISOString()
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[LSRS] Iteration ${index + 1} failed:`, error);
        result = {
          iteration: index + 1,
          parameters,
          metrics: emptyMetrics(),
          score: null,
          durationMs: Math.round(performance.now() - iterationStart),
          status: 'error',
          error: message,
          createdAt: new Date().toISOString()
        };
        job.failedIterations += 1;
      }

      job.results.push(result);
      job.completedIterations += 1;
      job.updatedAt = new Date().toISOString();
      await persistJob(job);
      notifyJob(job);

      if (!stopRequested && index < job.totalIterations - 1) {
        await delay(job.request.options.delayMs);
      }
    }

    job.status = stopRequested ? 'stopped' : 'completed';
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (job.request.options.restoreOriginals && Object.keys(job.originalParameters).length) {
      try {
        if (job.binding) assertChartContext(job.context);
        await applyParameterValues(job.originalParameters);
      } catch (error) {
        const restoreError = error instanceof Error ? error.message : String(error);
        job.error = job.error ? `${job.error} Restore failed: ${restoreError}` : `Restore failed: ${restoreError}`;
      }
    }

    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.currentParameters = undefined;
    isRunning = false;
    stopRequested = false;
    hideOverlay();
    await persistJob(job);
    notifyJob(job);
  }
}

function buildValueSets(parameters: OptimizationParameter[]): Array<{ name: string; values: ParameterValue[] }> {
  return parameters
    .filter(parameter => parameter.enabled)
    .map(parameter => {
      if (parameter.kind !== 'number') {
        return {
          name: parameter.name,
          values: Array.from(new Set(parameter.values ?? []))
        };
      }

      const start = Number(parameter.start);
      const end = Number(parameter.end);
      const step = Number(parameter.step);
      const count = Math.floor((end - start) / step + 1e-9) + 1;
      const precision = Math.min(12, Math.max(
        decimalPlaces(start),
        decimalPlaces(end),
        decimalPlaces(step)
      ));
      const values = Array.from({ length: count }, (_, index) =>
        Number((start + index * step).toFixed(precision))
      );

      return { name: parameter.name, values };
    });
}

function combinationAt(
  index: number,
  valueSets: Array<{ name: string; values: ParameterValue[] }>
): Record<string, ParameterValue> {
  const result: Record<string, ParameterValue> = {};
  let remainder = index;

  for (let position = valueSets.length - 1; position >= 0; position -= 1) {
    const set = valueSets[position];
    const valueIndex = remainder % set.values.length;
    result[set.name] = set.values[valueIndex];
    remainder = Math.floor(remainder / set.values.length);
  }

  return result;
}

async function getStrategyParameters(): Promise<DetectedParameter[]> {
  const dialog = await openSettingsPanel();
  await selectInputsTab(dialog);
  const controls = await discoverParameterControls(dialog, true);

  originalParameters = Object.fromEntries(
    controls.map(control => [control.label, control.currentValue])
  );

  return controls.map((control, index) => {
    const detected: DetectedParameter = {
      id: `parameter-${index}-${slug(control.label)}`,
      name: control.label,
      kind: control.kind,
      currentValue: control.currentValue,
      options: control.options
    };

    if (control.kind === 'number') {
      const current = Number(control.currentValue);
      const magnitude = Math.abs(current);
      const defaultStep = magnitude === 0
        ? 1
        : magnitude < 1
          ? Number((magnitude / 10).toPrecision(1))
          : Math.max(1, Math.round(magnitude / 10));
      detected.start = current >= 0 ? Math.max(0, current / 2) : current * 2;
      detected.end = current === 0 ? 10 : current >= 0 ? current * 2 : current / 2;
      detected.step = defaultStep || 1;
    }

    return detected;
  });
}

async function applyParameterValues(parameters: Record<string, ParameterValue>): Promise<void> {
  if (!Object.keys(parameters).length) throw new Error('No parameter values were supplied.');
  await openSettingsPanel();
  await setParametersInOpenDialog(parameters);
  await applySettings();
}

async function openSettingsPanel(): Promise<HTMLElement> {
  const existing = getSettingsDialog();
  if (existing) return existing;

  const selectors = [
    '[data-qa-id*="legend-source-item"]:has([title="Active strategy"]) [data-qa-id*="legend-settings-action"]',
    '[data-qa-id*="legend-source-item"]:has([aria-label="Active strategy"]) [data-qa-id*="legend-settings-action"]',
    '[data-qa-id*="legend-settings-action"]',
    '[data-name="legend-settings-action"]',
    '[data-name*="legend"] [data-name*="settings"]',
    'button[aria-label*="Settings"]',
    'button[aria-label*="設定"]',
    'button[aria-label*="设置"]'
  ];

  let settingsButton = selectors
    .map(selector => document.querySelector(selector))
    .find(element => element instanceof HTMLElement) as HTMLElement | undefined;

  if (!settingsButton) {
    const svgs = Array.from(document.querySelectorAll('svg'));
    settingsButton = svgs
      .map(svg => svg.closest('button, [role="button"]'))
      .find(element => {
        const label = element?.getAttribute('aria-label') ?? '';
        return /settings|設定|设置|properties/i.test(label);
      }) as HTMLElement | undefined;
  }

  if (!settingsButton) {
    throw new Error('Strategy settings button was not found. Open the strategy settings window and try again.');
  }

  settingsButton.click();
  return waitForElement(getSettingsDialog, 5000, 'Strategy settings dialog did not open.');
}

function getSettingsDialog(): HTMLElement | null {
  const existing = document.querySelector(
    '[data-name="indicator-properties-dialog"], [data-dialog-name="indicator-properties"], [role="dialog"][class*="properties"]'
  ) as HTMLElement | null;
  if (existing) return existing;
  return Array.from(document.querySelectorAll('[role="dialog"]')).find(node => {
    const tabs = Array.from(node.querySelectorAll('[role="tab"]')).map(tab => normalize(tab.textContent || ''));
    return tabs.some(t => /^(inputs|輸入|输入)$/.test(t)) && tabs.some(t => /^(properties|屬性|属性)$/.test(t));
  }) as HTMLElement || null;
}

async function selectInputsTab(dialog: HTMLElement): Promise<void> {
  const inputLabels = ['inputs', 'input', '輸入', '输入', '入力', '입력'];
  const tab = Array.from(dialog.querySelectorAll('[role="tab"]'))
    .find(element => inputLabels.some(label => normalize(element.textContent ?? '').includes(normalize(label))));

  if (tab instanceof HTMLElement && tab.getAttribute('aria-selected') !== 'true') {
    tab.click();
    await delay(300);
  }
}

async function discoverParameterControls(
  dialog: HTMLElement,
  collectSelectOptions: boolean
): Promise<ParameterControl[]> {
  const controls: ParameterControl[] = [];
  const cells = Array.from(dialog.querySelectorAll('div[class*="cell-"]'));

  for (let index = 0; index < cells.length; index += 1) {
    const labelCell = cells[index] as HTMLElement;
    if (!labelCell.className.includes('first-')) continue;
    const valueCell = cells[index + 1] as HTMLElement | undefined;
    if (!valueCell) continue;
    const label = getControlLabel(labelCell);
    if (!label) continue;
    const control = await detectControl(label, valueCell, collectSelectOptions);
    if (control) controls.push(control);
  }

  if (controls.length) return dedupeControls(controls);

  const labels = Array.from(dialog.querySelectorAll('label'));
  for (const labelElement of labels) {
    const label = labelElement.textContent?.trim();
    if (!label) continue;
    const targetId = labelElement.getAttribute('for');
    const target = targetId
      ? dialog.querySelector(`#${cssEscape(targetId)}`)
      : labelElement.parentElement;
    if (!(target instanceof HTMLElement)) continue;
    const control = await detectControl(label, target, collectSelectOptions);
    if (control) controls.push(control);
  }

  return dedupeControls(controls);
}

async function detectControl(
  label: string,
  container: HTMLElement,
  collectSelectOptions: boolean
): Promise<ParameterControl | null> {
  const checkbox = container.querySelector(
    'input[type="checkbox"], [role="checkbox"], [role="switch"]'
  ) as HTMLElement | null;
  if (checkbox) {
    return {
      label,
      kind: 'boolean',
      element: checkbox,
      currentValue: getCheckedState(checkbox),
      options: ['true', 'false']
    };
  }

  const select = container.querySelector(
    'select, [role="combobox"], button[aria-haspopup="listbox"], [aria-haspopup="listbox"]'
  ) as HTMLElement | null;
  if (select) {
    const options = select instanceof HTMLSelectElement
      ? Array.from(select.options).map(option => option.text.trim()).filter(Boolean)
      : collectSelectOptions
        ? await readCustomSelectOptions(select)
        : [];
    return {
      label,
      kind: 'select',
      element: select,
      currentValue: getSelectValue(select),
      options
    };
  }

  const input = container.querySelector(
    'input[data-qa-id="ui-lib-Input-input"], input[type="number"], input[inputmode="decimal"], input'
  ) as HTMLInputElement | null;
  if (input && isNumericInput(input)) {
    return {
      label,
      kind: 'number',
      element: input,
      currentValue: parseNumber(input.value) ?? 0
    };
  }

  return null;
}

async function readCustomSelectOptions(element: HTMLElement): Promise<string[]> {
  const previousValue = getSelectValue(element);
  element.click();
  await delay(150);
  const options = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] [data-value]'))
    .map(option => option.textContent?.trim() ?? '')
    .filter(Boolean);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (!options.length && previousValue) return [previousValue];
  return Array.from(new Set(options));
}

async function setParametersInOpenDialog(parameters: Record<string, ParameterValue>): Promise<void> {
  const dialog = getSettingsDialog();
  if (!dialog) throw new Error('Strategy settings dialog is not open.');
  await selectInputsTab(dialog);
  const controls = await discoverParameterControls(dialog, false);
  const byName = new Map(controls.map(control => [normalize(control.label), control]));
  const missing: string[] = [];

  for (const [name, value] of Object.entries(parameters)) {
    const control = byName.get(normalize(name));
    if (!control) {
      missing.push(name);
      continue;
    }
    await setControlValue(control, value);
  }

  if (missing.length) {
    throw new Error(`TradingView inputs not found: ${missing.join(', ')}`);
  }
}

async function setControlValue(control: ParameterControl, value: ParameterValue): Promise<void> {
  if (control.kind === 'number' && control.element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(control.element, String(value));
    dispatchInputEvents(control.element);
    return;
  }

  if (control.kind === 'boolean') {
    const desired = value === true || String(value).toLowerCase() === 'true';
    if (control.element instanceof HTMLInputElement && control.element.type === 'checkbox') {
      if (control.element.checked !== desired) control.element.click();
    } else if (getCheckedState(control.element) !== desired) {
      control.element.click();
    }
    await delay(80);
    return;
  }

  if (control.element instanceof HTMLSelectElement) {
    const option = Array.from(control.element.options).find(candidate =>
      normalize(candidate.text) === normalize(String(value))
      || normalize(candidate.value) === normalize(String(value))
    );
    if (!option) throw new Error(`Option "${value}" is not available for "${control.label}".`);
    control.element.value = option.value;
    dispatchInputEvents(control.element);
    return;
  }

  control.element.click();
  const option = await waitForElement(
    () => Array.from(document.querySelectorAll('[role="option"], [role="listbox"] [data-value]'))
      .find(candidate => normalize(candidate.textContent ?? '') === normalize(String(value))) as HTMLElement | undefined,
    2500,
    `Option "${value}" is not available for "${control.label}".`
  );
  option.click();
  await delay(100);
}

async function applySettings(): Promise<void> {
  const dialog = getSettingsDialog();
  if (!dialog) throw new Error('Strategy settings dialog disappeared.');

  const submit = dialog.querySelector(
    '[data-name="submit-button"], button[name="submit"], button[type="submit"]'
  ) as HTMLElement | null;
  const fallback = Array.from(dialog.querySelectorAll('button'))
    .find(button => /^(ok|確定|确定|適用|apply)$/i.test(button.innerText.trim()));
  const button = submit ?? fallback;
  if (!button) throw new Error('TradingView settings submit button was not found.');
  button.click();
  await delay(150);
}

async function waitForCalculation(baselineFingerprint: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let sawBusy = false;
  let changedAt = 0;
  let lastFingerprint = baselineFingerprint;

  while (Date.now() - startedAt < timeoutMs) {
    const busy = isReportBusy();
    const fingerprint = getReportFingerprint();
    sawBusy ||= busy;

    if (fingerprint && fingerprint !== baselineFingerprint) {
      if (fingerprint !== lastFingerprint) {
        changedAt = Date.now();
        lastFingerprint = fingerprint;
      } else if (!busy && Date.now() - changedAt >= 500) {
        return;
      }
    }

    if (sawBusy && !busy && Date.now() - startedAt >= 500) {
      await delay(400);
      return;
    }

    // Some TradingView layouts do not expose a busy state when a result is
    // unchanged. Accept a stable report after a conservative grace period.
    if (!sawBusy && fingerprint && Date.now() - startedAt >= Math.min(5000, timeoutMs * 0.6)) {
      return;
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(`TradingView report did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
}

function isReportBusy(): boolean {
  const selectors = [
    '[data-qa-id*="backtesting-loading"]',
    '#bottom-area [role="progressbar"]',
    '#bottom-area [aria-busy="true"]',
    '#bottom-area [class*="spinner"]',
    '#bottom-area [class*="loading"][class*="visible"]'
  ];
  return selectors.some(selector => {
    const element = document.querySelector(selector) as HTMLElement | null;
    return element ? isVisible(element) : false;
  });
}

function getReportFingerprint(): string {
  const report = document.querySelector(
    '#bottom-area [data-name*="strategy"], #bottom-area [class*="report"], #bottom-area table'
  ) as HTMLElement | null;
  const text = report?.innerText ?? '';
  return normalize(text).slice(-12000);
}

async function closeTradingViewError(): Promise<string | null> {
  const error = document.querySelector(
    '[class*="container-danger-"], [data-name="error-dialog"], [class*="toast-"][class*="danger-"]'
  ) as HTMLElement | null;
  if (!error || !isVisible(error)) return null;

  const message = error.innerText.trim() || 'TradingView reported a strategy error.';
  const close = error.querySelector(
    'button[class*="close"], button[data-name="submit-button"], button[name="ok"]'
  ) as HTMLElement | null;
  close?.click();
  await delay(100);
  return message;
}

async function getBacktestMetrics(): Promise<BacktestMetrics> {
  let raw: Record<string, unknown> = {};

  try {
    const result = await sendToPageContext('getPerformance');
    if (result && typeof result === 'object') raw = result as Record<string, unknown>;
  } catch (error) {
    console.warn('[LSRS] Page API metrics unavailable, using DOM report.', error);
  }

  const flattened = flattenNumericValues(raw);
  const dom = getDomMetrics();
  const metrics: BacktestMetrics = {
    netProfit: findMetric(flattened, ['netprofit', 'totalnetprofit']) ?? dom.netProfit,
    netProfitPercent: findMetric(flattened, ['netprofitpercent', 'netprofitpct']) ?? dom.netProfitPercent,
    maxDrawdown: findMetric(flattened, ['maxdrawdown', 'maximumdrawdown']) ?? dom.maxDrawdown,
    maxDrawdownPercent: findMetric(flattened, ['maxdrawdownpercent', 'maximumdrawdownpercent']) ?? dom.maxDrawdownPercent,
    winRate: findMetric(flattened, ['percentprofitable', 'winrate']) ?? dom.winRate,
    profitFactor: findMetric(flattened, ['profitfactor']) ?? dom.profitFactor,
    sharpeRatio: findMetric(flattened, ['sharperatio']) ?? dom.sharpeRatio,
    sortinoRatio: findMetric(flattened, ['sortinoratio']) ?? dom.sortinoRatio,
    totalTrades: findMetric(flattened, ['totalclosedtrades', 'totaltrades']) ?? dom.totalTrades,
    profitableTrades: findMetric(flattened, ['profitabletrades', 'winningtrades']) ?? dom.profitableTrades,
    raw
  };

  const hasMetric = Object.entries(metrics)
    .some(([key, value]) => key !== 'raw' && value !== null);
  if (!hasMetric) throw new Error('TradingView report was found but no performance metrics could be read.');
  return metrics;
}

function getDomMetrics(root?: HTMLElement, visibleOnly = false): Omit<BacktestMetrics, 'raw'> {
  const rows = Array.from(root ? root.querySelectorAll('tr, [role="row"]')
    : document.querySelectorAll('#bottom-area tr, #bottom-area [role="row"]'))
    .filter(row => !visibleOnly || isVisible(row as HTMLElement));
  const rowMap = new Map<string, string[]>();

  rows.forEach(row => {
    const cells = Array.from(row.querySelectorAll('th, td, [role="cell"], [role="rowheader"]'))
      .map(cell => (cell as HTMLElement).innerText.trim())
      .filter(Boolean);
    if (cells.length >= 2) rowMap.set(normalize(cells[0]), cells.slice(1));
  });

  const findRow = (labels: string[]): string[] => {
    for (const [label, values] of rowMap.entries()) {
      if (labels.some(candidate => label.includes(normalize(candidate)))) return values;
    }
    return [];
  };

  const netProfitValues = findRow(['net profit', 'total net profit', '淨利潤', '淨損益', '總損益', '净利润', '净损益']);
  const drawdownValues = findRow(['max drawdown', 'maximum drawdown', '最大資產回撤', '最大回撤', '最大回撤']);
  const winRateValues = findRow(['percent profitable', 'win rate', '勝率', '获利交易']);

  return {
    netProfit: firstNumeric(netProfitValues, false),
    netProfitPercent: firstNumeric(netProfitValues, true),
    maxDrawdown: firstNumeric(drawdownValues, false),
    maxDrawdownPercent: firstNumeric(drawdownValues, true),
    winRate: firstNumeric(winRateValues, true) ?? firstNumeric(winRateValues, false),
    profitFactor: firstNumeric(findRow(['profit factor', '獲利因子', '盈利因子']), false),
    sharpeRatio: firstNumeric(findRow(['sharpe ratio', '夏普比率']), false),
    sortinoRatio: firstNumeric(findRow(['sortino ratio', '索提諾比率', '索提诺比率']), false),
    totalTrades: firstNumeric(findRow(['total closed trades', 'total trades', '交易總數', '总交易次数']), false),
    profitableTrades: firstNumeric(findRow(['profitable trades', 'winning trades', '獲利交易', '盈利交易']), false)
  };
}

function flattenNumericValues(
  value: unknown,
  path: string[] = [],
  output = new Map<string, number>()
): Map<string, number> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    output.set(normalize(path.join(' ')), value);
    return output;
  }

  if (typeof value === 'string') {
    const parsed = parseNumber(value);
    if (parsed !== null) output.set(normalize(path.join(' ')), parsed);
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenNumericValues(item, [...path, String(index)], output));
    return output;
  }

  if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>)
      .forEach(([key, nested]) => flattenNumericValues(nested, [...path, key], output));
  }

  return output;
}

function findMetric(values: Map<string, number>, aliases: string[]): number | null {
  const normalizedAliases = aliases.map(normalize);
  for (const [key, value] of values.entries()) {
    if (normalizedAliases.some(alias => key.includes(alias))) return value;
  }
  return null;
}

function calculateScore(
  metrics: BacktestMetrics,
  objective: ObjectiveMetric,
  direction: ObjectiveDirection
): number | null {
  const value = metrics[objective];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return direction === 'maximize' ? value : -value;
}

function emptyMetrics(): BacktestMetrics {
  return {
    netProfit: null,
    netProfitPercent: null,
    maxDrawdown: null,
    maxDrawdownPercent: null,
    winRate: null,
    profitFactor: null,
    sharpeRatio: null,
    sortinoRatio: null,
    totalTrades: null,
    profitableTrades: null,
    raw: {}
  };
}

function sendToPageContext(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      reject(new Error(`Page API timed out for ${action}.`));
    }, 10000);

    const handler = (event: MessageEvent) => {
      if (settled || event.source !== window || event.data?.source !== 'tva-page-context') return;
      if (event.data.action !== `${action}Result`) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener('message', handler);
      if (event.data.success) resolve(event.data.result ?? event.data.data);
      else reject(new Error(event.data.error || 'Page API failed.'));
    };

    window.addEventListener('message', handler);
    window.postMessage({ source: 'tva-content-script', action, params }, '*');
  });
}

async function persistJob(job: OptimizationJob, setActive = false): Promise<void> {
  const indexResult = await chrome.storage.local.get(REPORT_INDEX_KEY);
  const index = Array.isArray(indexResult[REPORT_INDEX_KEY])
    ? indexResult[REPORT_INDEX_KEY] as any[]
    : [];
  const entry = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    strategyName: job.context.strategyName,
    symbol: job.context.symbol,
    interval: job.context.interval,
    completedIterations: job.completedIterations,
    totalIterations: job.totalIterations,
    objective: job.request.options.objective
  };
  const nextIndex = [entry, ...index.filter(item => item.id !== job.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 100);

  const values: Record<string, unknown> = {
    [`${JOB_PREFIX}${job.id}`]: job,
    [REPORT_INDEX_KEY]: nextIndex
  };
  if (setActive) values[ACTIVE_JOB_KEY] = job.id;
  await chrome.storage.local.set(values);
}

function notifyJob(job: OptimizationJob): void {
  try {
    chrome.runtime.sendMessage({ type: 'OPTIMIZATION_JOB_UPDATED', job }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // The popup is normally closed while an optimization runs.
  }
}

function showOverlay(job: OptimizationJob): void {
  hideOverlay();
  overlayElement = document.createElement('aside');
  overlayElement.id = 'tva-optimization-overlay';
  overlayElement.innerHTML = `
    <div class="tva-overlay-card">
      <div class="tva-overlay-brand">TVA</div>
      <div class="tva-overlay-content">
        <strong>Strategy optimization is running</strong>
        <span id="tva-overlay-progress">0 / ${job.totalIterations}</span>
        <small id="tva-overlay-parameters"></small>
        <div class="tva-progress-track"><i id="tva-progress-value"></i></div>
      </div>
      <button id="tva-overlay-stop" type="button">Stop</button>
    </div>
  `;

  const style = document.createElement('style');
  style.id = 'tva-overlay-style';
  style.textContent = `
    #tva-optimization-overlay{position:fixed;z-index:2147483647;right:18px;bottom:18px;font:13px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eaf0ff}
    .tva-overlay-card{display:flex;align-items:center;gap:12px;width:390px;padding:13px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(17,28,52,.96);box-shadow:0 18px 45px rgba(0,0,0,.3);backdrop-filter:blur(12px)}
    .tva-overlay-brand{display:grid;width:40px;height:40px;place-items:center;border-radius:12px;background:linear-gradient(135deg,#326ce5,#2ac19c);font-weight:900}
    .tva-overlay-content{display:grid;min-width:0;flex:1;gap:2px}.tva-overlay-content span{color:#77dfc3;font-weight:800}.tva-overlay-content small{overflow:hidden;color:#aebbd3;text-overflow:ellipsis;white-space:nowrap}
    .tva-progress-track{height:4px;margin-top:4px;overflow:hidden;border-radius:99px;background:rgba(255,255,255,.12)}.tva-progress-track i{display:block;width:0;height:100%;background:#59d5b6;transition:width .2s}
    #tva-overlay-stop{padding:7px 10px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:transparent;color:#fff;cursor:pointer}
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlayElement);
  overlayElement.querySelector('#tva-overlay-stop')?.addEventListener('click', () => {
    stopRequested = true;
  });
}

function updateOverlay(job: OptimizationJob, parameters: Record<string, ParameterValue>): void {
  const progress = overlayElement?.querySelector('#tva-overlay-progress');
  const parameterText = overlayElement?.querySelector('#tva-overlay-parameters');
  const progressValue = overlayElement?.querySelector('#tva-progress-value') as HTMLElement | null;
  if (progress) progress.textContent = `${job.completedIterations + 1} / ${job.totalIterations}`;
  if (parameterText) {
    parameterText.textContent = Object.entries(parameters)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(' · ');
  }
  if (progressValue) {
    progressValue.style.width = `${(job.completedIterations + 1) / job.totalIterations * 100}%`;
  }
}

function hideOverlay(): void {
  overlayElement?.remove();
  document.getElementById('tva-overlay-style')?.remove();
  overlayElement = null;
}

function getTradingViewContext(): TradingViewContext {
  const strategyName = firstText([
    '[data-qa-id="backtesting"] [class*="titleText"]',
    '[data-strategy-title]',
    '[data-name="legend-source-title"]',
    '#bottom-area [class*="strategyGroup"] [class*="title"]'
  ]) || 'TradingView Strategy';
  const chartLabel = document.querySelector('canvas[aria-label^="Chart for "]')?.getAttribute('aria-label');
  const chartIdentity = chartLabel ? /^Chart for (.+), ([^,]+)$/.exec(chartLabel) : null;
  const symbolAttribute = chartIdentity?.[1] || document.querySelector('[data-symbol-full]')?.getAttribute('data-symbol-full');
  const urlSymbol = new URL(location.href).searchParams.get('symbol');
  const symbol = symbolAttribute || firstText([
    '[data-symbol-full]',
    '[data-name="legend-source-item"] [class*="title"]',
    '[data-name="header-toolbar-symbol-search"]'
  ]) || urlSymbol || document.title.split(' ')[0] || 'Unknown symbol';
  const interval = chartIdentity?.[2] || document.querySelector('#header-toolbar-intervals [aria-checked="true"]')?.getAttribute('data-value') || firstText([
    '[data-name="header-intervals-button"]',
    'button[aria-label*="interval"]',
    'button[aria-label*="時間週期"]'
  ]) || Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find(button =>
    /^\d+\s*(second|minute|hour|day|week|month|秒|分鐘|小时|小時|天|日|週|周|月)s?$/i.test(button.getAttribute('aria-label') || ''))?.getAttribute('aria-label') || 'Current interval';

  return {
    strategyName: strategyName.trim(),
    symbol: symbol.trim(),
    interval: interval.trim(),
    url: location.href
  };
}

function firstText(selectors: string[]): string {
  for (const selector of selectors) {
    const element = document.querySelector(selector) as HTMLElement | null;
    const text = element?.innerText?.trim() || element?.getAttribute('data-symbol-full')?.trim();
    if (text) return text;
  }
  return '';
}

function getControlLabel(element: HTMLElement): string {
  return (
    element.querySelector('div[class*="inner-"], label, [class*="label"]')?.textContent
    ?? element.textContent
    ?? ''
  ).trim();
}

function dedupeControls(controls: ParameterControl[]): ParameterControl[] {
  const seen = new Set<string>();
  return controls.filter(control => {
    const key = normalize(control.label);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getCheckedState(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) return element.checked;
  return element.getAttribute('aria-checked') === 'true'
    || element.getAttribute('data-checked') === 'true';
}

function getSelectValue(element: HTMLElement): string {
  if (element instanceof HTMLSelectElement) {
    return element.selectedOptions[0]?.text.trim() || element.value;
  }
  return element.getAttribute('aria-label')?.trim()
    || element.textContent?.trim()
    || '';
}

function isNumericInput(input: HTMLInputElement): boolean {
  return input.type === 'number'
    || input.inputMode === 'decimal'
    || input.inputMode === 'numeric'
    || parseNumber(input.value) !== null;
}

function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

function firstNumeric(values: string[], percentOnly: boolean): number | null {
  for (const value of values) {
    const hasPercent = value.includes('%');
    if (percentOnly !== hasPercent) continue;
    const parsed = parseNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseNumber(value: string): number | null {
  const normalizedValue = value
    .replace(/\u2212/g, '-')
    .replace(/\s/g, '')
    .replace(/,/g, '')
    .replace(/[^\d.+-]/g, '');
  if (!normalizedValue || !/\d/.test(normalizedValue)) return null;
  const parsed = Number.parseFloat(normalizedValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s%()_\-/:：.]/g, '');
}

function slug(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 30) || 'input';
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

function createJobId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

async function waitForElement<T extends HTMLElement>(
  finder: () => T | null | undefined,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = finder();
    if (found) return found;
    await delay(100);
  }
  throw new Error(errorMessage);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}
