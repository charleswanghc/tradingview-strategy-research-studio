import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchStore } from '../dist/research/store.js';
import { researchStartSchema, strategyTitle } from '../dist/contracts/research.js';
import { createChromeFixture, bridgeModule, until } from './fixtures.mjs';
const source = '//@version=6\nstrategy("Test revision", overlay=true)\nstrategy.entry("L", strategy.long)\n';
const period = { start: '2020-01-01', end: '2025-12-31' };

async function setup(t, maxRounds = 2) {
  const root = fileURLToPath(new URL('../.local/', import.meta.url)); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'research-test-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(root) + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))); await rm(directory, { recursive: true, force: true }); });
  const fixture = createChromeFixture(); const handler = bridgeModule.createCommandHandler(fixture.api);
  const bridge = { request: (command, args) => handler(command, args), status: () => ({ connected: true }) };
  const store = new ResearchStore(bridge, directory);
  fixture.first.state.exportReport = async (roundId, format) => {
    const dir = join(directory, 'downloads', 'TradingViewAssistant', roundId); await mkdir(dir, { recursive: true });
    const filename = join(dir, format === 'csv' ? 'trades.csv' : 'report.xlsx');
    await writeFile(filename, format === 'csv' ? '\ufeffTrade #,Type,Signal,Net P&L USD\n1,Exit long,"quoted, signal",10\n2,Exit long,"multi\nline",-3\n' : 'PK fixture archive');
    return { format, downloadId: 1, filename, bytes: (await readFile(filename)).length };
  };
  const result = await store.create({ tabId: 1, expectedContext: fixture.first.state.context, period, goal: 'Compare versions', maxRounds, timeoutMs: 30000 });
  return { store, fixture, bridge, directory, sessionId: result.session.id };
}
async function completed(store, sessionId) {
  let result;
  await until(async () => { result = await store.get({ sessionId }); return result.session.status !== 'running'; });
  return result.session;
}

test('research preserves source, authentic exported files, CSV pages and analysis across bounded revisions', async t => {
  const { store, fixture, sessionId, directory, bridge } = await setup(t);
  const original = fixture.first.state.editorSource;
  await store.submit({ sessionId, source, rationale: 'First proposal' });
  let session = await completed(store, sessionId);
  assert.equal(session.status, 'awaiting_analysis'); assert.equal(session.rounds[0].csv.rows, 2);
  const code = await store.artifact({ sessionId, round: 1, artifact: 'source' });
  assert.match(code.text, /\[TVA .* #1\]/);
  assert.equal((await store.artifact({ sessionId, round: 0, artifact: 'source' })).text, original);
  const rows = await store.artifact({ sessionId, round: 1, artifact: 'trades', limit: 1 });
  assert.equal(rows.rows[0][2], 'quoted, signal'); assert.equal(rows.nextOffset, 1);
  assert.equal((await store.artifact({ sessionId, round: 1, artifact: 'trades', offset: 1 })).rows[0][2], 'multi\nline');
  const meta = JSON.parse((await store.artifact({ sessionId, round: 1, artifact: 'metadata' })).text);
  assert.equal(meta.sourceHash, session.rounds[0].sourceHash); assert.deepEqual(meta.period, period);
  await assert.rejects(() => store.submit({ sessionId, source, rationale: 'Skip analysis' }), /not waiting/);
  await store.review({ sessionId, round: 1, analysis: 'Two exits, including a losing trade. Change the entry rule.', decision: 'continue' });
  // A fresh MCP process can continue an idle session without replaying its first version.
  const restarted = new ResearchStore(bridge, directory);
  await restarted.submit({ sessionId, source, rationale: 'Second proposal' });
  session = await completed(restarted, sessionId); assert.equal(session.rounds.length, 2);
  const final = await restarted.review({ sessionId, round: 2, analysis: 'Stop at the requested limit.', decision: 'continue' });
  assert.equal(final.session.status, 'completed'); assert.match(final.session.stopReason, /Maximum rounds/);
  await assert.rejects(() => restarted.submit({ sessionId, source, rationale: 'Third' }), /round limit/);
  await restarted.restoreEditor({ sessionId }); assert.equal(fixture.first.state.editorSource, original);
  assert.equal(fixture.second.state.editorSource, original);
});

test('simultaneous revisions reserve one round; stop targets the bound inactive chart and retains source', async t => {
  const { store, fixture, sessionId } = await setup(t);
  let release; fixture.first.state.deepWait = () => new Promise(resolve => { release = resolve; });
  const outcomes = await Promise.allSettled([store.submit({ sessionId, source, rationale: 'A' }), store.submit({ sessionId, source, rationale: 'B' })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  await until(() => !!release);
  await store.stop({ sessionId }); release();
  const result = await completed(store, sessionId); assert.equal(result.status, 'stopped');
  assert.ok(result.rounds[0].artifacts.source); assert.equal(fixture.second.messages.some(message => message.type === 'STOP_RESEARCH_ROUND'), false);
});

test('manual editor changes and compiler errors stop research rather than overwriting or exporting stale data', async t => {
  const { store, fixture, sessionId } = await setup(t);
  fixture.first.state.editorSource += '// manual change';
  await store.submit({ sessionId, source, rationale: 'Must not overwrite' });
  const result = await completed(store, sessionId);
  assert.equal(result.status, 'failed'); assert.match(result.rounds[0].error, /EDITOR_CHANGED/);
  assert.equal(result.rounds[0].artifacts.trades, undefined); assert.match(fixture.first.state.editorSource, /manual change/);
  const next = await setup(t); next.fixture.first.state.compileError = true;
  await next.store.submit({ sessionId: next.sessionId, source, rationale: 'Compiler failure' });
  const failed = await completed(next.store, next.sessionId); assert.equal(failed.status, 'failed'); assert.match(failed.rounds[0].error, /COMPILE/);
});

test('chart changes and reloaded content sessions stop the loop without applying to a new target', async t => {
  const { store, fixture, sessionId } = await setup(t);
  let release; fixture.first.state.deepWait = () => new Promise(resolve => { release = resolve; });
  await store.submit({ sessionId, source, rationale: 'Context check' }); await until(() => !!release);
  fixture.first.state.context.symbol = 'OTHER:ASSET'; release();
  const failed = await completed(store, sessionId); assert.equal(failed.status, 'failed'); assert.match(failed.rounds[0].error, /CONTEXT_CHANGED/);
  const next = await setup(t); let secondRelease;
  next.fixture.first.state.deepWait = () => new Promise(resolve => { secondRelease = resolve; });
  await next.store.submit({ sessionId: next.sessionId, source, rationale: 'Reload check' }); await until(() => !!secondRelease);
  next.fixture.addTab(1);
  assert.equal((await next.store.get({ sessionId: next.sessionId })).session.status, 'failed'); secondRelease();
});

test('wrong download identities, malformed report data, invalid dates and traversal are rejected', async t => {
  assert.throws(() => researchStartSchema.parse({ tabId: 1, expectedContext: {}, period: { start: '2025-01-01', end: '2020-01-01' }, goal: 'x' }));
  assert.throws(() => strategyTitle('//@version=6\nindicator("No strategy")'), /strategy must/);
  const { store, fixture, sessionId } = await setup(t);
  fixture.first.state.exportReport = async (_roundId, format) => ({ format, downloadId: 1, filename: 'C:/unrelated/trades.csv', bytes: 100 });
  await store.submit({ sessionId, source, rationale: 'File identity' });
  const failed = await completed(store, sessionId); assert.equal(failed.status, 'failed'); assert.match(failed.stopReason, /belong/);
  await assert.rejects(() => store.artifact({ sessionId: '../outside', round: 0, artifact: 'source' }));
  const next = await setup(t); const originalExport = next.fixture.first.state.exportReport;
  next.fixture.first.state.exportReport = async (id, format) => {
    const download = await originalExport(id, format);
    if (format === 'csv') await writeFile(download.filename, '<html>Login,required</html>');
    return download;
  };
  await next.store.submit({ sessionId: next.sessionId, source, rationale: 'Reject non-report download' });
  assert.equal((await completed(next.store, next.sessionId)).status, 'failed');
});
