import { createServer, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, responseSchema, type BridgeCommand, type CommandBridge } from '../contracts/protocol.js';

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export class ExtensionBridge implements CommandBridge {
  private http: Server;
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private connection: WebSocket | undefined;
  private extensionId: string | undefined;
  private pending = new Map<string, {
    resolve: (data: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private port: number;

  constructor(private readonly token: string, port: number, private readonly timeoutMs = 30000) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Bridge token must be 32 random bytes encoded as hex.');
    this.port = port;
    this.http = createServer((_request, response) => { response.writeHead(404); response.end(); });
    this.http.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {});
      const origin = request.headers.origin;
      if (request.url !== '/bridge' || request.headers.host !== `127.0.0.1:${this.port}`
        || !origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, connection => this.authenticate(connection, origin.slice(19)));
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, '127.0.0.1', () => {
        this.http.removeListener('error', reject);
        const address = this.http.address();
        if (address && typeof address !== 'string') this.port = address.port;
        resolve();
      });
    });
    this.heartbeat = setInterval(() => {
      if (this.connection?.readyState === WebSocket.OPEN) this.connection.send(JSON.stringify({ type: 'ping' }));
    }, 20000);
    this.heartbeat.unref();
  }

  status(): Record<string, unknown> {
    return { connected: this.connection?.readyState === WebSocket.OPEN,
      extensionId: this.extensionId ?? null, port: this.port, protocolVersion: PROTOCOL_VERSION };
  }

  request(command: BridgeCommand, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const connection = this.connection;
    if (!connection || connection.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeError('BRIDGE_DISCONNECTED', 'Open extension MCP settings, import pairing.json, and enable the connection.'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeError('BRIDGE_TIMEOUT', 'The extension did not respond in time. A timed-out write may have executed; query its state before retrying.'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      connection.send(JSON.stringify({ type: 'request', version: PROTOCOL_VERSION, requestId, command, args }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
      });
    });
  }

  private authenticate(connection: WebSocket, originId: string): void {
    const timer = setTimeout(() => connection.close(1008, 'Authentication timeout'), 5000);
    connection.on('error', () => connection.close());
    connection.once('close', () => clearTimeout(timer));
    connection.once('message', raw => {
      clearTimeout(timer);
      let hello: { type?: string; version?: number; token?: string; extensionId?: string };
      try { hello = JSON.parse(raw.toString()); } catch { connection.close(1008, 'Invalid hello'); return; }
      const supplied = typeof hello.token === 'string' ? Buffer.from(hello.token) : Buffer.alloc(0);
      const expected = Buffer.from(this.token);
      if (hello.type !== 'hello' || hello.version !== PROTOCOL_VERSION || hello.extensionId !== originId
        || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        connection.close(1008, 'Authentication rejected'); return;
      }
      if (this.connection?.readyState === WebSocket.OPEN) { connection.close(1008, 'Another extension is connected'); return; }
      this.connection = connection;
      this.extensionId = originId;
      connection.send(JSON.stringify({ type: 'ready', version: PROTOCOL_VERSION }));
      connection.on('message', rawResponse => {
        let data: unknown;
        try { data = JSON.parse(rawResponse.toString()); } catch { return; }
        const parsed = responseSchema.safeParse(data);
        if (!parsed.success) return;
        const response = parsed.data;
        const pending = this.pending.get(response.requestId);
        if (!pending) return;
        this.pending.delete(response.requestId);
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve(response.data);
        else pending.reject(new BridgeError(response.error.code, response.error.message));
      });
      connection.once('close', () => {
        if (this.connection !== connection) return;
        this.connection = undefined;
        this.extensionId = undefined;
        this.rejectPending('BRIDGE_DISCONNECTED', 'Extension disconnected. Running chart jobs may continue; reconnect and query before retrying.');
      });
    });
  }

  private rejectPending(code: string, message: string): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new BridgeError(code, message)); }
    this.pending.clear();
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.rejectPending('BRIDGE_CLOSED', 'MCP server is closing.');
    for (const client of this.sockets.clients) client.terminate();
    await new Promise<void>(resolve => this.sockets.close(() => resolve()));
    await new Promise<void>(resolve => this.http.close(() => resolve()));
  }
}
