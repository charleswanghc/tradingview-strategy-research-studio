import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from './contracts/protocol.js';
import { ExtensionBridge } from './bridge/server.js';
import { createMcpServer } from './tools/register.js';
import { ResearchStore } from './research/store.js';
import { startDashboard } from './dashboard/server.js';
import { spawn } from 'node:child_process';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = resolve(process.env.TVA_DATA_DIR || resolve(projectDirectory, '.local'));
const port = Number(process.env.TVA_BRIDGE_PORT || DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('TVA_BRIDGE_PORT must be an integer from 1024 to 65535.');
await mkdir(dataDirectory, { recursive: true });
const tokenPath = resolve(dataDirectory, 'bridge-token');
let token: string;
try { token = (await readFile(tokenPath, 'utf8')).trim(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  token = randomBytes(32).toString('hex');
  try { await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 }); }
  catch (writeError) {
    if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
    token = (await readFile(tokenPath, 'utf8')).trim();
  }
}
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local bridge-token file.');
const pairingPath = resolve(dataDirectory, 'pairing.json');
await writeFile(pairingPath, JSON.stringify({ version: 1, url: `ws://127.0.0.1:${port}/bridge`, token }, null, 2), { mode: 0o600 });
const clientPath = resolve(dataDirectory, 'mcp-client.json');
await writeFile(clientPath, JSON.stringify({ mcpServers: { 'tradingview-assistant': {
  command: process.execPath, args: [fileURLToPath(import.meta.url)],
  env: { TVA_BRIDGE_PORT: String(port), TVA_DATA_DIR: dataDirectory }
} } }, null, 2));
const codexPath = resolve(dataDirectory, 'codex-mcp.toml');
await writeFile(codexPath, `[mcp_servers.tradingview-assistant]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fileURLToPath(import.meta.url))}]\n\n[mcp_servers.tradingview-assistant.env]\nTVA_BRIDGE_PORT = ${JSON.stringify(String(port))}\nTVA_DATA_DIR = ${JSON.stringify(dataDirectory)}\n`);

if (process.argv.includes('--setup')) {
  console.error(`Pairing file: ${pairingPath}\nMCP client configuration: ${clientPath}\nCodex configuration snippet: ${codexPath}`);
} else {
  const bridge = new ExtensionBridge(token, port);
  try { await bridge.listen(); }
  catch (error) {
    console.error(`Cannot start bridge on 127.0.0.1:${port}. Another MCP client may already be using it.`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const dashboardMode = process.argv.includes('--dashboard');
  const dashboardPort = Number(process.env.TVA_DASHBOARD_PORT || 17366);
  if (dashboardMode && (!Number.isInteger(dashboardPort) || dashboardPort < 1024 || dashboardPort > 65535)) {
    await bridge.close(); throw new Error('Invalid TVA_DASHBOARD_PORT.');
  }
  const dashboard = dashboardMode ? await startDashboard(bridge, dataDirectory, dashboardPort, {version:1,url:`ws://127.0.0.1:${port}/bridge`,token}) : undefined;
  const server = dashboardMode ? undefined : createMcpServer(bridge, new ResearchStore(bridge, dataDirectory));
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    if (dashboard) {
      try { await dashboard.controller.stop(); } catch { /* Persisted active IDs are retained for recovery. */ }
      await new Promise<void>(resolve => dashboard.server.close(() => resolve()));
    }
    await server?.close();
    await bridge.close();
  }
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && (message as {type?: string}).type === 'studio-shutdown') void shutdown().then(() => process.exit(0));
  });
  if (!dashboardMode) process.stdin.once('end', () => void shutdown());
  if (dashboard) {
    await writeFile(resolve(dataDirectory,'dashboard','launch-url.txt'), dashboard.url, {mode:0o600});
    console.error(`TradingView Assistant research dashboard ready: ${dashboard.baseUrl}\nOpen the launch URL in ${resolve(dataDirectory,'dashboard','launch-url.txt')}\nBridge: 127.0.0.1:${port}; pairing: ${pairingPath}`);
    if (process.argv.includes('--open') && process.platform === 'win32') {
      const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command',`Start-Process -WindowStyle Hidden -FilePath '${dashboard.url}'`], {windowsHide:true});
      child.on('error', () => console.error('Could not open the browser; use launch-url.txt.'));
    }
  } else {
    await server!.connect(new StdioServerTransport());
    console.error(`TradingView Assistant MCP ready; bridge 127.0.0.1:${port}. Import ${pairingPath} in extension MCP settings.`);
  }
}
