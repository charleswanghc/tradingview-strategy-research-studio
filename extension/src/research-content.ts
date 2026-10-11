/** Classic content script, loaded before content.ts. The adapter is isolated for DOM fixture testing. */
namespace TVAResearch {
  type Request = import('../../shared/research.types').ResearchRoundRequest;
  type State = import('../../shared/research.types').ResearchRoundState;
  type Period = import('../../shared/research.types').ResearchPeriod;
  const visible = (node: Element | null): node is HTMLElement => !!node && !!(node as HTMLElement).getClientRects().length;
  const text = (node: Element) => [(node as HTMLElement).innerText, node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('id')].filter(Boolean).join(' ').trim();
  const sleep = (ms = 250) => new Promise<void>(resolve => setTimeout(resolve, ms));
  function control(root: ParentNode, labels: RegExp): HTMLElement | undefined {
    const matches = Array.from(root.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"]'))
      .filter(node => visible(node) && labels.test(text(node))) as HTMLElement[];
    if (matches.length > 1) throw new Error('AMBIGUOUS_CONTROL: More than one TradingView control matched.');
    return matches[0];
  }
  function report(): HTMLElement {
    const root = document.querySelector('[data-name="strategy-report"], [data-name="strategy-tester"], #bottom-area');
    if (!visible(root)) throw new Error('STRATEGY_REPORT_UNAVAILABLE: Open the strategy report on the target chart.');
    return root;
  }
  async function background(message: Record<string, unknown>): Promise<any> {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error || !response?.result) throw new Error(response?.error || 'Extension background did not respond.');
    return response.result;
  }
  async function poll(check: () => boolean | Promise<boolean>, timeout: number, stopped: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (stopped()) throw new Error('RESEARCH_STOPPED');
      if (await check()) return;
      await sleep();
    }
    throw new Error(description);
  }
  function nativeValue(input: HTMLInputElement, value: string): void {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    if (input.value !== value) throw new Error('The testing date control rejected the requested date.');
  }
  function dateInputs(root: ParentNode): HTMLInputElement[] {
    return Array.from(root.querySelectorAll('input')).filter(node => visible(node)
      && (node.type === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(node.value) || /date|日期|年月|yyyy|from|to|start|end/i.test(`${node.placeholder} ${node.getAttribute('aria-label') || ''}`))) as HTMLInputElement[];
  }
  function periodControl(root: ParentNode): HTMLElement | undefined {
    return control(root, /testing period|測試期間|回測期間|测试期间|回测期间|\d{4}.*[—–].*\d{4}/i);
  }
  function checkAccess(): void {
    const blocked = Array.from(document.querySelectorAll('[role="dialog"], [class*="overlap-manager"]'))
      .find(node => visible(node) && /session disconnected|your session ended|工作階段.*中斷/i.test((node as HTMLElement).innerText));
    if (blocked) throw new Error('TRADINGVIEW_SESSION_DISCONNECTED: 請在 Chrome 確認並重新連線自己的 TradingView 工作階段。');
  }
  function deepActive(root: HTMLElement): boolean {
    const reset = control(root, /reset to chart session|重設為圖表|重置為圖表|重置为图表/i);
    const toggle = Array.from(root.querySelectorAll('input[type="checkbox"], [role="switch"], [role="checkbox"]')).find(node => /deep backtest|深度回測|深度回测/i.test(text(node)));
    return !!reset || !!toggle && ((toggle as HTMLInputElement).checked || toggle.getAttribute('aria-checked') === 'true')
      || !!root.querySelector('[data-name="deep-backtesting-status"][data-active="true"]')
      || Array.from(root.querySelectorAll('span, button')).some(node => visible(node) && /^DEEP$/i.test((node.textContent || '').trim()));
  }
  function periodConfirmed(root: HTMLElement, period: Period): boolean {
    const inputs = dateInputs(root);
    if (inputs.length === 2 && inputs[0].value === period.start && inputs[1].value === period.end
      && inputs.every(input => input.getAttribute('aria-invalid') !== 'true')) return true;
    const selected = periodControl(root);
    if (!selected) return false;
    const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const display = compact(`${text(selected)} ${selected.getAttribute('data-tooltip') || ''}`);
    const variants = (date: string) => {
      const [year, month, day] = date.split('-').map(Number);
      const instant = new Date(`${date}T00:00:00Z`);
      return [date, `${month}/${day}/${year}`, `${day}/${month}/${year}`,
        instant.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
        instant.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })].map(compact);
    };
    return variants(period.start).some(value => display.includes(value)) && variants(period.end).some(value => display.includes(value));
  }

  export const adapter = {
    async readEditor(): Promise<string> {
      checkAccess();
      const existing = document.querySelector('[data-name="pine-editor"], [data-name="pine-editor-container"], #pine-editor, .monaco-editor, .CodeMirror');
      if (!visible(existing)) {
        const open = control(document, /^pine(?:\s|$)|^pine 編輯器|^pine编辑器/i);
        if (!open) throw new Error('PINE_EDITOR_UNAVAILABLE: Sign in and open the Pine Editor.');
        open.click();
        await poll(() => visible(document.querySelector('.monaco-editor, .CodeMirror')), 10000, () => false, 'Pine Editor did not open.');
      }
      return (await background({ type: 'RESEARCH_EDITOR', action: 'read' })).source;
    },
    async writeEditor(source: string, expected: string): Promise<void> {
      await background({ type: 'RESEARCH_EDITOR', action: 'write', source, expectedSource: expected });
    },
    async applyParameters(values: Record<string, number | boolean | string>): Promise<void> {
      const parameters = await getStrategyParameters();
      for (const [name, value] of Object.entries(values)) {
        const parameter = parameters.find(p => p.name === name);
        if (!parameter || typeof value !== (parameter.kind === 'number' ? 'number' : parameter.kind === 'boolean' ? 'boolean' : 'string')
          || parameter.kind === 'select' && parameter.options?.length && !parameter.options.includes(String(value))) throw new Error(`PARAMETER_NOT_FOUND: ${name}`);
      }
      await applyParameterValues(values);
      const actual = await getStrategyParameters();
      if (!Object.entries(values).every(([name, value]) => actual.find(p => p.name === name)?.currentValue === value)) throw new Error('PARAMETER_VERIFY_FAILED');
    },
    async timezone(zone: string, set = false): Promise<void> {
      checkAccess();
      // Only UTC is currently automated; never claim other zones without reading their control.
      if (!['UTC', 'Etc/UTC'].includes(zone)) throw new Error('TIMEZONE_UNSUPPORTED: 此版本請使用 Etc/UTC。');
      const utcLabel = /^(?:\d{2}:\d{2}(?::\d{2})?\s+)?UTC(?:\s|$)/i;
      let utc = control(document, utcLabel);
      if (!utc && set) {
        const button = control(document, /change timezone|time zone|時區|时区/i);
        if (!button) throw new Error('TIMEZONE_CONTROL_UNAVAILABLE: 請在圖表底部將時區設為 UTC。');
        button.click(); await sleep(150);
        const item = control(document, /^\(UTC\+0\) UTC|^UTC(?:\s|$)/i);
        if (!item) throw new Error('TIMEZONE_CONTROL_UNAVAILABLE: 請手動將時區設為 UTC。');
        item.click(); await sleep(150); utc = control(document, utcLabel);
      }
      if (!utc) throw new Error('TIMEZONE_CHANGED: 請在圖表底部將時區設為 UTC。');
    },
    chartOptions(symbol: string): void {
      if (!symbol.includes('!')) return;
      const checkbox = (label: RegExp) => Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')).find(node => visible(node) && label.test(text(node)));
      const adjustment = checkbox(/adjust for contract changes|調整.*合約|调整.*合约/i);
      const settlement = checkbox(/use settlement as close|結算.*收盤|结算.*收盘/i);
      const checked = (node: Element) => (node as HTMLInputElement).checked || node.getAttribute('aria-checked') === 'true';
      if (!adjustment || !settlement || checked(adjustment) || !checked(settlement)) throw new Error('CHART_OPTIONS_CHANGED: 連續期貨請關閉 B-ADJ 並開啟 SET，以維持相同測試基準。');
    },
    async compile(title: string, stopped: () => boolean): Promise<void> {
      const root = document.querySelector('[data-name="pine-editor"], [data-name="pine-editor-container"], #pine-editor') || document;
      const apply = control(root, /^add to chart(?:\s|$)|^update on chart(?:\s|$)|^添加到圖表|^新增至圖表|^更新至圖表|^添加到图表|^更新到图表/i);
      if (!apply) throw new Error('PINE_COMPILE_CONTROL_UNAVAILABLE: Open the Pine Editor and its Add/Update on chart control.');
      apply.click();
      await poll(() => {
        const errors = Array.from(root.querySelectorAll('[role="alert"], [data-name="pine-error-message"], [class*="errorMessage"]')).filter(visible);
        if (errors.length) throw new Error(`PINE_COMPILE_ERROR: ${errors.map(text).join(' ').slice(0, 2000)}`);
        const titles = Array.from(document.querySelectorAll('[data-name="legend-source-title"], [data-qa-id*="legend-source-title"], [data-strategy-title]'));
        return titles.some(node => visible(node) && (node.textContent || '').trim() === title);
      }, 60000, stopped, 'Pine compilation was not confirmed by the versioned strategy title on the chart.');
    },
    async configureDeep(period: Period, timeout: number, stopped: () => boolean, title?: string): Promise<{ text: string; completedAt: string }> {
      checkAccess();
      const open = control(document, /(?:^|\s)(?:open )?strategy report(?:\s|$)|^strategy tester(?:\s|$)|^策略報告|^策略測試器|^策略报告|^策略测试器/i);
      open?.click();
      await poll(() => visible(document.querySelector('[data-name="strategy-report"], [data-name="strategy-tester"], #bottom-area')), 10000, stopped, 'Strategy report did not open.');
      const root = report();
      if (title && !root.innerText.includes(title)) throw new Error('The selected strategy report does not match the versioned Pine strategy.');
      const resultText = () => root.innerText;
      const before = resultText();
      const selectedPeriod = periodControl(root);
      if (selectedPeriod) {
        selectedPeriod.click(); await sleep(100);
        const custom = control(document, /custom (?:date )?range|自訂.*(?:範圍|期間)|自定义.*(?:范围|期间)/i);
        custom?.click();
      } else {
        const toggle = control(root, /deep backtest|深度回測|深度回测/i);
        if (!toggle) throw new Error('DEEP_BACKTEST_UNAVAILABLE: Premium or higher and supported date controls are required.');
        if (toggle.getAttribute('aria-checked') !== 'true' && !(toggle as HTMLInputElement).checked) toggle.click();
      }
      let inputs: HTMLInputElement[] = [];
      await poll(() => { inputs = dateInputs(document); return inputs.length === 2; }, 5000, stopped, 'Two unambiguous testing date inputs were not found.');
      const start = inputs.find(input => /from|start|開始|起始|开始/i.test(`${input.placeholder} ${input.getAttribute('aria-label')}`)) || inputs[0];
      const end = inputs.find(input => /to|end|結束|结束/i.test(`${input.placeholder} ${input.getAttribute('aria-label')}`)) || inputs[1];
      if (start === end) throw new Error('Testing start and end date controls are ambiguous.');
      nativeValue(start, period.start); nativeValue(end, period.end);
      const dialog = start.closest('[role="dialog"]');
      if (dialog) {
        const apply = control(dialog, /^select(?:\s|$)|^apply(?:\s|$)|^ok(?:\s|$)|^選擇|^套用|^確定|^确定/i);
        if (!apply) throw new Error('The testing date confirmation button was not found.');
        apply.click();
      }
      const refresh = control(root, /update report|generate report|更新報告|產生報告|生成报告|更新报告/i);
      let sawBusy = false;
      const busy = () => Array.from(root.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-qa-id*="loading"], [class*="spinner"]')).some(visible)
        || /updating report|更新報告中|正在更新報告/i.test(root.innerText);
      sawBusy = busy();
      refresh?.click();
      let stableSince = 0;
      let previous = '';
      await poll(() => {
        if (!deepActive(root) || !periodConfirmed(root, period)) return false;
        const error = Array.from(root.querySelectorAll('[role="alert"], [class*="error"]')).find(node => visible(node)
          && /no data for.*period|沒有.*資料|無.*資料|failed.*recalculat/i.test(text(node)));
        if (error) throw new Error(text(error));
        const current = resultText();
        sawBusy ||= busy();
        if (busy()) { stableSince = 0; return false; }
        // Require an observable new report; never accept an old stable report on a timer.
        if (!current || !sawBusy && current === before) return false;
        if (current !== previous || !stableSince) { previous = current; stableSince = Date.now(); return false; }
        return Date.now() - stableSince >= 1000;
      }, timeout, stopped, 'A completed, fresh Deep Backtesting report was not confirmed.');
      return { text: root.innerText.slice(0, 12000), completedAt: new Date().toISOString() };
    },
    async exportReport(roundId: string, format: 'csv' | 'xlsx', strategyTitle: string): Promise<import('../../shared/research.types').ResearchDownload> {
      return background({ type: 'RESEARCH_EXPORT', roundId, format, strategyTitle });
    },
    async clickExport(format: 'csv' | 'xlsx'): Promise<void> {
      const root = report();
      if (!deepActive(root)) throw new Error('Deep Backtesting is no longer active.');
      if (format === 'csv') {
        const trades = control(root, /^trades(?:\s|$)|^list of trades(?:\s|$)|^交易清單|^交易列表/i);
        if (!trades) throw new Error('The strategy trades tab was not found.');
        trades.click(); await sleep(150);
        const download = control(root, /download(?:\s|$)|下載|下载/i);
        if (!download) throw new Error('The TradingView trades CSV download control was not found.');
        download.click();
      } else {
        let download = control(root, /download.*xlsx|匯出.*xlsx|下載.*xlsx|下载.*xlsx/i);
        if (!download) {
          const menu = control(root, /open context menu|more|更多|report menu|報告選單|開啟內容選單/i);
          if (!menu) throw new Error('The full strategy report export menu was not found.');
          menu.click(); await sleep(100);
          download = control(document, /download.*xlsx|匯出.*xlsx|下載.*xlsx|下载.*xlsx/i);
        }
        if (!download) throw new Error('The TradingView full XLSX export control was not found.');
        download.click();
      }
    },
    validateChart(expected: import('../../shared/optimization.types').TradingViewContext, title?: string): void {
      checkAccess();
      const current = getTradingViewContext();
      if (!['symbol', 'interval', 'url'].every(key => current[key] === expected[key])) throw new Error('The chart symbol, timeframe, or URL changed.');
      if (title && !Array.from(document.querySelectorAll('[data-name="legend-source-title"], [data-qa-id*="legend-source-title"], [data-strategy-title]')).some(node => visible(node) && node.textContent?.trim() === title)) {
        throw new Error('The versioned research strategy is no longer on the chart.');
      }
      adapter.chartOptions(expected.symbol);
    },
    validateReport(title: string): void {
      const root = report();
      if (!deepActive(root) || !root.innerText.includes(title)) throw new Error('The selected deep report changed during the research round.');
    },
    metrics(): Omit<import('../../shared/optimization.types').BacktestMetrics, 'raw'> {
      // Read the selected deep report DOM, never the ordinary chart performance object.
      if (!deepActive(report())) throw new Error('Deep Backtesting is no longer active.');
      return getDomMetrics(report(), true);
    }
  };

  export function progress(state: State, stop: () => void): void {
    if (!document.body) return;
    let panel = document.getElementById('tva-research-progress');
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'tva-research-progress'; panel.setAttribute('role', 'status');
      panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:340px;padding:16px;border:1px solid #334155;border-radius:12px;background:#0f172a;color:#e2e8f0;font:13px/1.6 system-ui;box-shadow:0 8px 30px #0006';
      const label = document.createElement('span'); label.style.display = 'block';
      const button = document.createElement('button'); button.style.cssText = 'margin-top:10px;padding:6px 12px;cursor:pointer';
      panel.appendChild(label); panel.appendChild(button); document.body.appendChild(panel);
    }
    const phases: Record<string, string> = { preparing: '準備中', editing: '更新策略程式碼', compiling: '編譯策略',
      deep_backtesting: '執行深度回測', exporting_csv: '下載交易 CSV', exporting_xlsx: '下載完整報告',
      completed: '本輪已完成，等待 AI 分析', stopped: '已停止', failed: '本輪失敗' };
    panel.querySelector('span')!.textContent = `策略研究 · ${phases[state.phase] || state.phase}${state.error ? `：${state.error.slice(0, 220)}` : ''}`;
    const button = panel.querySelector('button')!;
    button.textContent = state.status === 'running' ? '停止策略研究' : '關閉進度';
    button.onclick = state.status === 'running' ? stop : () => panel!.remove();
  }

  export async function execute(request: Request, state: State, persist: () => Promise<void>, stopped: () => boolean): Promise<void> {
    const checkpoint = (phase: string) => { state.phase = phase; state.updatedAt = new Date().toISOString(); return persist(); };
    const check = (withTitle = false) => {
      if (stopped()) throw new Error('RESEARCH_STOPPED');
      adapter.validateChart(request.expectedContext, withTitle ? request.strategyTitle : undefined);
    };
    try {
      check(); await checkpoint('editing'); check();
      await adapter.writeEditor(request.source, request.expectedEditorSource); state.editorWritten = true;
      check(); await checkpoint('compiling'); check();
      await adapter.compile(request.strategyTitle, stopped);
      if (request.timezone) await adapter.timezone(request.timezone);
      if (request.parameters && Object.keys(request.parameters).length) {
        await checkpoint('applying_parameters'); await adapter.applyParameters(request.parameters); check(true);
      }
      check(true); await checkpoint('deep_backtesting'); check(true);
      state.reportEvidence = await adapter.configureDeep(request.period, request.timeoutMs, stopped, request.strategyTitle);
      check(true); adapter.validateReport(request.strategyTitle);
      if (request.timezone) await adapter.timezone(request.timezone);
      state.metrics = adapter.metrics();
      await checkpoint('exporting_csv'); check(true); adapter.validateReport(request.strategyTitle);
      state.downloads.push(await adapter.exportReport(request.roundId, 'csv', request.strategyTitle));
      check(true);
      if (request.exportXlsx) {
        await checkpoint('exporting_xlsx'); check(true); adapter.validateReport(request.strategyTitle);
        state.downloads.push(await adapter.exportReport(request.roundId, 'xlsx', request.strategyTitle));
      }
      check(true); adapter.validateReport(request.strategyTitle);
      const actualSource = await adapter.readEditor();
      if (actualSource.replace(/\r\n/g, '\n') !== request.source.replace(/\r\n/g, '\n')) throw new Error('Pine source changed during the backtest.');
      state.context = { ...getTradingViewContext(), strategyName: request.strategyTitle };
      state.status = 'completed';
      state.phase = 'completed';
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = stopped() ? 'stopped' : 'failed'; state.phase = state.status;
    } finally {
      state.updatedAt = new Date().toISOString(); await persist();
    }
  }
}
