import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeFixture, bridgeModule, until } from './fixtures.mjs';
import { startSchema } from '../dist/contracts/protocol.js';
const { createCommandHandler } = bridgeModule;

const range = { name: 'Length', kind: 'number', start: 1, end: 3, step: 1 };
test('parameter ranges reject invalid steps, duplicate names and oversized ranges', () => {
  const fixture = createChromeFixture();
  const args = { tabId: 1, expectedContext: fixture.first.state.context, parameters: [range] };
  assert.equal(startSchema.safeParse(args).success, true);
  assert.equal(startSchema.safeParse({ ...args, parameters: [{ ...range, step: 0 }] }).success, false);
  assert.equal(startSchema.safeParse({ ...args, parameters: [range, range] }).success, false);
  assert.equal(startSchema.safeParse({ ...args, parameters: [{ ...range, end: 20001 }] }).success, false);
});

test('real content runner stores combinations, restores live originals and strips raw report data', async () => {
  const fixture = createChromeFixture();
  const handle = createCommandHandler(fixture.api);
  const detected = await handle('get_parameters', { tabId: 1 });
  const started = await handle('start_optimization', { tabId: 1, expectedContext: detected.expectedContext, parameters: [range] });
  assert.equal(started.job.binding.tabId, 1);
  await until(async () => (await handle('get_job', { jobId: started.job.id })).job.status === 'completed');
  const report = await handle('get_report', { jobId: started.job.id, offset: 1, limit: 1 });
  assert.equal(report.total, 3);
  assert.equal(report.nextOffset, 2);
  assert.equal(report.results[0].parameters.Length, 2);
  assert.equal(report.job.bestResult.parameters.Length, 3);
  assert.equal('raw' in report.results[0].metrics, false);
  assert.equal('raw' in report.job.bestResult.metrics, false);
  assert.equal(fixture.first.state.values.Length, 3);
  assert.equal(fixture.second.state.applied.length, 0);
  assert.ok(fixture.first.messages.every(message => message.type !== 'START_OPTIMIZATION' || message.request.parameters[0].currentValue === 3));
});

test('writes reject chart context changes and unknown parameters', async () => {
  const fixture = createChromeFixture();
  const handle = createCommandHandler(fixture.api);
  const detected = await handle('get_parameters', { tabId: 1 });
  fixture.first.state.context.interval = '4h';
  await assert.rejects(handle('apply_parameters', { tabId: 1, expectedContext: detected.expectedContext, parameters: { Length: 7 } }), { code: 'CONTEXT_CHANGED' });
  assert.equal(fixture.first.state.applied.length, 0);
  const current = await handle('get_parameters', { tabId: 1 });
  await assert.rejects(handle('run_backtest', { tabId: 1, expectedContext: current.expectedContext, parameters: { Unknown: 7 } }), { code: 'PARAMETER_NOT_FOUND' });
});

test('stop targets the original tab while another tab is active and prevents concurrent writes', async () => {
  const fixture = createChromeFixture();
  let release;
  fixture.first.state.wait = () => new Promise(resolve => { release = resolve; });
  const handle = createCommandHandler(fixture.api);
  const detected = await handle('get_parameters', { tabId: 1 });
  const started = await handle('start_optimization', { tabId: 1, expectedContext: detected.expectedContext, parameters: [range] });
  await until(() => !!release);
  await assert.rejects(handle('apply_parameters', { tabId: 1, expectedContext: detected.expectedContext, parameters: { Length: 9 } }), { code: 'ALREADY_RUNNING' });
  const stopping = await handle('stop_optimization', { jobId: started.job.id });
  assert.equal(stopping.status, 'STOPPING');
  release();
  await until(async () => (await handle('get_job', { jobId: started.job.id })).job.status === 'stopped');
  assert.equal(fixture.first.state.values.Length, 3);
  assert.ok(fixture.first.messages.some(message => message.type === 'STOP_OPTIMIZATION' && message.jobId === started.job.id));
  assert.equal(fixture.second.messages.length, 0);
});

test('reloaded sessions retain reports and reject restoring a job into a different session', async () => {
  const fixture = createChromeFixture();
  const handle = createCommandHandler(fixture.api);
  const started = await handle('run_backtest', { tabId: 1, expectedContext: fixture.first.state.context, parameters: { Length: 4 } });
  await until(async () => (await handle('get_job', { jobId: started.job.id })).job.status === 'completed');
  const key = `lsrs:job:${started.job.id}`;
  fixture.stored[key].status = 'running';
  fixture.addTab(1);
  const read = await handle('get_job', { jobId: started.job.id });
  assert.equal(read.job.status, 'failed');
  assert.match(read.job.error, /interrupted/);
  assert.equal((await handle('get_report', { jobId: started.job.id })).results.length, 1);
  await assert.rejects(handle('restore_parameters', { jobId: started.job.id }), { code: 'SESSION_CHANGED' });
});

test('a running job can still be stopped after chart context changes, without restoring into the new context', async () => {
  const fixture = createChromeFixture();
  let release;
  fixture.first.state.wait = () => new Promise(resolve => { release = resolve; });
  const handle = createCommandHandler(fixture.api);
  const started = await handle('start_optimization', { tabId: 1, expectedContext: fixture.first.state.context, parameters: [range] });
  await until(() => !!release);
  fixture.first.state.context.symbol = 'TEST:OTHER';
  assert.equal((await handle('stop_optimization', { jobId: started.job.id })).status, 'STOPPING');
  release();
  await until(async () => (await handle('get_job', { jobId: started.job.id })).job.status === 'stopped');
  const report = await handle('get_report', { jobId: started.job.id });
  assert.match(report.job.error, /Restore failed/);
  assert.equal(fixture.first.state.values.Length, 1);
});

test('content reserves a new job before asynchronous storage completes', async () => {
  const fixture = createChromeFixture();
  const detected = await createCommandHandler(fixture.api)('get_parameters', { tabId: 1 });
  const message = { type: 'START_OPTIMIZATION', request: { parameters: [{ ...range, id: 'length', enabled: true, currentValue: 3 }],
    options: { objective: 'netProfit', direction: 'maximize', maxIterations: 3, timeoutMs: 5000, delayMs: 250, restoreOriginals: true } } };
  const [first, second] = await Promise.all([fixture.api.tabs.sendMessage(1, message), fixture.api.tabs.sendMessage(1, message)]);
  assert.equal(first.status, 'STARTED');
  assert.equal(second.status, 'ALREADY_RUNNING');
  await until(() => fixture.stored[`lsrs:job:${first.job.id}`]?.status === 'completed');
  assert.equal(fixture.stored[`lsrs:job:${first.job.id}`].results.length, 3);
  assert.equal(detected.tabId, 1);
});
