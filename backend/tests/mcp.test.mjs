import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { WebSocket } from 'ws';
import { createChromeFixture, bridgeModule, until } from './fixtures.mjs';
const { installMcpBridge } = bridgeModule;

async function availablePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('stdio MCP client runs through the authenticated extension bridge and real content job runner', { timeout: 20000 }, async t => {
  const localRoot = new URL('../.local/', import.meta.url);
  await mkdir(localRoot, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('test-', localRoot)));
  const fixture = createChromeFixture();
  const port = await availablePort();
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { TVA_DATA_DIR: directory, TVA_BRIDGE_PORT: String(port) }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', chunk => { diagnostics += chunk; });
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends WebSocket {
    constructor(url) { super(url, { origin: `chrome-extension://${fixture.api.runtime.id}` }); }
  };
  t.after(async () => {
    await fixture.api.storage.local.set({ 'lsrs:mcp-settings': { enabled: false } });
    await until(() => fixture.stored['lsrs:mcp-status']?.state === 'disabled');
    await client.close();
    globalThis.WebSocket = originalWebSocket;
    assert.ok(resolve(directory).startsWith(resolve(fileURLToPath(localRoot)) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 18);
  assert.ok(tools.tools.find(tool => tool.name === 'submit_research_revision'));
  assert.ok(tools.tools.find(tool => tool.name === 'start_optimization').inputSchema.properties.parameters);
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(response.content[0].text);
    return response.structuredContent;
  }
  assert.equal((await call('bridge_status')).connected, false);
  const disconnected = await client.callTool({ name: 'list_tradingview_tabs', arguments: {} });
  assert.equal(disconnected.isError, true);
  assert.equal(disconnected.structuredContent.code, 'BRIDGE_DISCONNECTED');
  const pairing = JSON.parse(await readFile(`${directory}/pairing.json`, 'utf8'));
  assert.equal(diagnostics.includes(pairing.token), false);
  await fixture.api.storage.local.set({ 'lsrs:mcp-settings': { ...pairing, enabled: true } });
  installMcpBridge(fixture.api);
  await until(async () => (await call('bridge_status')).connected);
  assert.equal((await call('list_tradingview_tabs')).tabs.length, 2);
  const detected = await call('get_strategy_parameters', { tabId: 1 });
  const started = await call('run_backtest', { tabId: 1, expectedContext: detected.expectedContext, parameters: { Length: 7 } });
  await until(async () => (await call('get_optimization_job', { jobId: started.job.id })).job.status === 'completed');
  const report = await call('get_optimization_report', { jobId: started.job.id, limit: 1 });
  assert.equal(report.results[0].metrics.netProfit, 70);
  assert.equal(report.job.completedIterations, 1);
  assert.equal('raw' in report.results[0].metrics, false);
  assert.equal(fixture.first.state.values.Length, 3);
  assert.equal(fixture.second.state.applied.length, 0);
  await call('apply_parameters', { tabId: 1, expectedContext: detected.expectedContext, parameters: { Length: 7 } });
  assert.equal(fixture.first.state.values.Length, 7);
  await call('restore_job_parameters', { jobId: started.job.id });
  assert.equal(fixture.first.state.values.Length, 3);
  fixture.first.state.exportReport = async (roundId, format) => {
    assert.equal(format, 'csv');
    const path = join(directory, 'downloads', 'TradingViewAssistant', roundId);
    await mkdir(path, { recursive: true }); const filename = join(path, 'trades.csv');
    await writeFile(filename, 'Trade #,Type,Net P&L USD\n1,Exit long,10\n');
    return { format, downloadId: 9, filename, bytes: 47 };
  };
  const environment = await call('inspect_research_environment', { tabId: 1 });
  const research = await call('create_strategy_research', { tabId: 1, expectedContext: environment.expectedContext,
    period: { start: '2020-01-01', end: '2025-12-31' }, goal: 'Integration fixture', maxRounds: 1, exportXlsx: false });
  const sessionId = research.session.id;
  await call('submit_research_revision', { sessionId, source: '//@version=6\nstrategy("Fixture research")\nstrategy.entry("L", strategy.long)', rationale: 'Integration test' });
  await until(async () => (await call('get_strategy_research', { sessionId })).session.status === 'awaiting_analysis');
  const trades = await call('read_research_artifact', { sessionId, round: 1, artifact: 'trades' });
  assert.equal(trades.rows[0][2], '10');
  const reviewed = await call('review_research_round', { sessionId, round: 1, analysis: 'Fixture analysis saved through stdio.', decision: 'finish' });
  assert.equal(reviewed.session.status, 'completed');
});
