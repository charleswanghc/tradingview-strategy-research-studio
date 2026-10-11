import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../dist/bridge/server.js';

const id = 'a'.repeat(32);
async function setup(t, timeout = 1000) {
  const token = randomBytes(32).toString('hex');
  const bridge = new ExtensionBridge(token, 0, timeout);
  await bridge.listen();
  t.after(() => bridge.close());
  return { token, bridge, url: `ws://127.0.0.1:${bridge.status().port}/bridge` };
}
async function connect(url, token, origin = `chrome-extension://${id}`) {
  const socket = new WebSocket(url, { origin });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', version: 1, token, extensionId: id }));
  return socket;
}

test('browser page origins cannot connect to the local command bridge', async t => {
  const { url } = await setup(t);
  const socket = new WebSocket(url, { origin: 'https://www.tradingview.com' });
  const [error] = await once(socket, 'error');
  assert.match(error.message, /403/);
});

test('wrong pairing token is rejected', async t => {
  const { bridge, url } = await setup(t);
  const socket = await connect(url, '0'.repeat(64));
  const [code] = await once(socket, 'close');
  assert.equal(code, 1008);
  assert.equal(bridge.status().connected, false);
});

test('authenticated requests are correlated, timed out, and rejected on disconnect', async t => {
  const { bridge, url, token } = await setup(t, 60);
  const socket = await connect(url, token);
  const [ready] = await once(socket, 'message');
  assert.equal(JSON.parse(ready.toString()).type, 'ready');
  socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    if (request.command === 'list_tabs') {
      socket.send(JSON.stringify({ type: 'response', requestId: 'unrelated', ok: true, data: { wrong: true } }));
      socket.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true, data: { tabs: [{ tabId: 7 }] } }));
    }
  });
  assert.deepEqual(await bridge.request('list_tabs', {}), { tabs: [{ tabId: 7 }] });
  await assert.rejects(bridge.request('get_job', { jobId: 'missing' }), { code: 'BRIDGE_TIMEOUT' });
  const pending = bridge.request('get_parameters', { tabId: 7 });
  const rejection = assert.rejects(pending, { code: 'BRIDGE_DISCONNECTED' });
  socket.close();
  await rejection;
  await assert.rejects(bridge.request('list_tabs', {}), { code: 'BRIDGE_DISCONNECTED' });
});
