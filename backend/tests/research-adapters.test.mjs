import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { extensionBuild } from './fixtures.mjs';
const pageCode = await readFile(new URL('research-page.js', extensionBuild), 'utf8');
const pageUrl = `data:text/javascript;base64,${Buffer.from(pageCode).toString('base64')}`;
const { pineEditorOperation } = await import(pageUrl);
const backgroundCode = (await readFile(new URL('research-background.js', extensionBuild), 'utf8')).replace("'./research-page.js'", JSON.stringify(pageUrl));
const { installResearchBackground } = await import(`data:text/javascript;base64,${Buffer.from(backgroundCode).toString('base64')}`);

test('MAIN-world editor preserves undo boundaries, verifies whole source and rejects manual changes', t => {
  const originalDocument = globalThis.document; const originalWindow = globalThis.window;
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  let value = 'first\nsecond\n'; let undo = 0;
  const root = { getClientRects: () => [1], matches: () => false, querySelector: () => null, contains: () => true };
  const model = { getValue: () => value, getFullModelRange: () => ({ startLineNumber: 1, endLineNumber: 3 }) };
  const editor = { getDomNode: () => root, getModel: () => model, pushUndoStop: () => { undo += 1; }, executeEdits: (_name, edits) => { value = edits[0].text; } };
  globalThis.document = { querySelector: () => root };
  globalThis.window = { monaco: { editor: { getEditors: () => [editor] } } };
  assert.equal(pineEditorOperation('read').source, value);
  pineEditorOperation('write', 'new\nwhole\nsource', value); assert.equal(undo, 2); assert.equal(value, 'new\nwhole\nsource');
  assert.throws(() => pineEditorOperation('write', 'overwrite', 'old'), /EDITOR_CHANGED/);
  globalThis.window.monaco.editor.getEditors = () => [editor, editor];
  assert.throws(() => pineEditorOperation('write', 'overwrite', value), /UNSUPPORTED/);
});

function backgroundFixture() {
  const listeners = {}; const record = {};
  const event = name => ({ addListener: callback => { listeners[name] = callback; } });
  const api = { runtime: { onMessage: event('message') }, scripting: { executeScript: async () => [{ result: { source: 'Pine fixture' } }] },
    tabs: { sendMessage: async () => ({ status: 'TRIGGERED' }) },
    downloads: { onDeterminingFilename: event('filename'), onChanged: event('changed'), search: async () => [record] } };
  installResearchBackground(api);
  const sender = { tab: { id: 1, url: 'https://www.tradingview.com/chart/test/' } };
  const send = message => new Promise(resolve => listeners.message(message, sender, resolve));
  return { listeners, record, send, sender };
}
const roundId = '11111111-1111-4111-8111-111111111111';
const request = { type: 'RESEARCH_EXPORT', roundId, format: 'csv', strategyTitle: 'Test [TVA aaaaaaaa #1]' };
test('download routing ignores unrelated origins and chart referrers and associates completion with the reserved round', async () => {
  const { send, listeners, record, sender } = backgroundFixture();
  const result = send(request); await new Promise(resolve => setImmediate(resolve));
  let suggested;
  const download = { id: 10, filename: 'C:/Downloads/Trades.csv', url: 'blob:https://evil.example/id', referrer: sender.tab.url, startTime: new Date().toISOString() };
  listeners.filename(download, value => { suggested = value; }); assert.equal(suggested, undefined);
  download.url = 'blob:https://www.tradingview.com/id'; download.referrer = 'https://www.tradingview.com/chart/other/';
  listeners.filename(download, value => { suggested = value; }); assert.equal(suggested, undefined);
  download.referrer = sender.tab.url; listeners.filename(download, value => { suggested = value; });
  assert.equal(suggested.filename, `LocalStrategyResearchStudio/${roundId}/trades.csv`);
  Object.assign(record, download, { state: 'complete', fileSize: 300, filename: `C:/Downloads/${suggested.filename}` });
  listeners.changed({ id: 99, state: { current: 'complete' } });
  listeners.changed({ id: 10, state: { current: 'complete' } });
  assert.equal((await result).result.downloadId, 10);
});
test('cancelled exports reject the pending request and release the export reservation', async () => {
  const { send } = backgroundFixture();
  const pending = send(request); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await send({ type: 'RESEARCH_CANCEL_EXPORT', roundId })).result.cancelled, true);
  assert.match((await pending).error, /stopped/);
  const second = send(request); await new Promise(resolve => setImmediate(resolve));
  await send({ type: 'RESEARCH_CANCEL_EXPORT', roundId }); assert.match((await second).error, /stopped/);
});

test('deep adapter rejects an unchanged old report instead of accepting it after a fixed delay', async () => {
  class Input {
    constructor(label) { this.label = label; this.type = 'date'; this.placeholder = label; this.current = ''; }
    get value() { return this.current; } set value(value) { this.current = value; }
    getClientRects() { return [1]; } getAttribute() { return null; } closest() { return null; } dispatchEvent() {}
  }
  const inputs = [new Input('Start date'), new Input('End date')];
  const toggle = { innerText: 'Deep Backtesting', getClientRects: () => [1], getAttribute: name => name === 'aria-checked' ? 'true' : null, click() {} };
  const result = { innerText: 'Old performance 100', getClientRects: () => [1] };
  const controls = [toggle];
  const root = { get innerText() { return `Test strategy Deep Backtesting ${result.innerText}`; }, getClientRects: () => [1],
    querySelector: () => null, querySelectorAll: selector => {
      if (selector === 'input') return inputs;
      if (selector.startsWith('button')) return controls;
      if (selector.startsWith('input[type=')) return [toggle];
      if (selector.startsWith('table')) return [result];
      return [];
    } };
  const document = { querySelector: () => root, querySelectorAll: selector => selector === 'input' ? inputs : [] };
  const sandbox = vm.createContext({ document, HTMLInputElement: Input, Event, setTimeout, Date, console,
    getDomMetrics: () => ({ netProfit: result.innerText.startsWith('New') ? 101 : 100 }) });
  vm.runInContext(await readFile(new URL('research-content.js', extensionBuild), 'utf8'), sandbox);
  await assert.rejects(() => vm.runInContext("TVAResearch.adapter.configureDeep({ start: '2020-01-01', end: '2025-12-31' }, 30, () => false, 'Test strategy')", sandbox), /fresh Deep Backtesting/);
  controls.push({ innerText: 'Update report', getClientRects: () => [1], getAttribute: () => null, click: () => { result.innerText = 'New performance 101'; } });
  const evidence = await vm.runInContext("TVAResearch.adapter.configureDeep({ start: '2020-01-01', end: '2025-12-31' }, 2500, () => false, 'Test strategy')", sandbox);
  assert.match(evidence.text, /New performance 101/);
});
