import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const extensionBuild = new URL('../../extension/.extension-build/', import.meta.url);
const contentSource = await readFile(new URL('content.js', extensionBuild), 'utf8');
const researchSource = await readFile(new URL('research-content.js', extensionBuild), 'utf8');
const bridgeSource = await readFile(new URL('mcp-bridge.js', extensionBuild), 'utf8');
export const bridgeModule = await import(`data:text/javascript;base64,${Buffer.from(bridgeSource).toString('base64')}`);
export const context = { strategyName: 'Fixture Strategy', symbol: 'TEST:ASSET', interval: '1D', url: 'https://www.tradingview.com/chart/test/' };

export async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for test state.');
}

export function createChromeFixture() {
  const stored = {};
  const changes = [];
  const tabs = new Map();
  const api = {
    runtime: { id: 'a'.repeat(32), sendMessage(_message, callback) { callback?.(); } },
    alarms: { create() {}, async clear() { return true; }, onAlarm: { addListener() {} } },
    storage: {
      onChanged: { addListener(listener) { changes.push(listener); } },
      local: {
        async get(keys) {
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in stored).map(key => [key, structuredClone(stored[key])]));
        },
        async set(values) {
          const event = {};
          for (const [key, value] of Object.entries(values)) {
            event[key] = { oldValue: stored[key], newValue: structuredClone(value) };
            stored[key] = structuredClone(value);
          }
          for (const listener of changes) listener(event, 'local');
        }
      }
    },
    tabs: {
      async query() { return [...tabs].map(([id, tab]) => ({ id, title: 'Fixture chart', url: tab.state.context.url, active: id === 2 })); },
      async get(id) { if (!tabs.has(id)) throw new Error('Tab closed'); return { id, url: tabs.get(id).state.context.url }; },
      async sendMessage(id, message) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('Tab closed');
        tab.messages.push(structuredClone(message));
        return new Promise(resolve => tab.listener(message, {}, resolve));
      }
    }
  };
  function addTab(id) {
    const state = { context: { ...context, url: `https://www.tradingview.com/chart/test${id}/` },
      values: { Length: 3, Enabled: true }, applied: [], wait: async () => {}, deepWait: async () => {},
      editorSource: '// @fixture\n//@version=6\nstrategy("Original")\n', exportReport: async () => { throw new Error('No download fixture installed.'); } };
    const tab = { state, messages: [], listener: null };
    const contentChrome = { ...api, runtime: { ...api.runtime, onMessage: { addListener(listener) { tab.listener = listener; } } } };
    const sandbox = vm.createContext({ chrome: contentChrome, crypto: globalThis.crypto, setTimeout, clearTimeout,
      performance, console: { info() {}, warn() {}, error() {} },
      document: { readyState: 'complete', getElementById() { return {}; } }, fixtureState: state });
    vm.runInContext(researchSource, sandbox);
    vm.runInContext(contentSource, sandbox, { filename: fileURLToPath(new URL('content.js', extensionBuild)) });
    vm.runInContext(`
      getTradingViewContext = () => ({ ...fixtureState.context });
      getStrategyParameters = async () => [
        { id: 'length', name: 'Length', kind: 'number', currentValue: fixtureState.values.Length },
        { id: 'enabled', name: 'Enabled', kind: 'boolean', currentValue: fixtureState.values.Enabled }
      ];
      openSettingsPanel = async () => ({});
      setParametersInOpenDialog = async values => {
        Object.assign(fixtureState.values, values);
        fixtureState.applied.push({ ...values });
      };
      applySettings = async () => {};
      waitForCalculation = async () => fixtureState.wait();
      getReportFingerprint = () => 'fixture-report';
      closeTradingViewError = async () => null;
      getBacktestMetrics = async () => ({ ...emptyMetrics(), netProfit: fixtureState.values.Length * 10,
        raw: { privateFixturePayload: 'omit this from MCP' } });
      showOverlay = () => {};
      updateOverlay = () => {};
      hideOverlay = () => {};
      delay = async () => {};
      TVAResearch.adapter.readEditor = async () => fixtureState.editorSource;
      TVAResearch.progress = () => {};
      TVAResearch.adapter.writeEditor = async (source, expected) => {
        if (fixtureState.editorSource !== expected) throw new Error('EDITOR_CHANGED');
        fixtureState.editorSource = source;
      };
      TVAResearch.adapter.compile = async title => {
        if (fixtureState.compileError) throw new Error('PINE_COMPILE_ERROR');
        fixtureState.context.strategyName = title;
      };
      TVAResearch.adapter.configureDeep = async () => {
        await fixtureState.deepWait();
        return { text: 'Deep Backtesting fixture report', completedAt: new Date().toISOString() };
      };
      TVAResearch.adapter.validateChart = (expected, title) => {
        if (!['symbol', 'interval', 'url'].every(key => fixtureState.context[key] === expected[key])) throw new Error('CONTEXT_CHANGED');
        if (title && fixtureState.context.strategyName !== title) throw new Error('STRATEGY_CHANGED');
      };
      TVAResearch.adapter.validateReport = title => {
        if (fixtureState.context.strategyName !== title) throw new Error('REPORT_CHANGED');
      };
      TVAResearch.adapter.metrics = () => ({ ...emptyMetrics(), raw: undefined, netProfit: 100 });
      TVAResearch.adapter.exportReport = (roundId, format) => fixtureState.exportReport(roundId, format);
    `, sandbox);
    tabs.set(id, tab);
    tab.sandbox = sandbox;
    return tab;
  }
  const first = addTab(1);
  const second = addTab(2);
  return { api, stored, tabs, first, second, addTab };
}
