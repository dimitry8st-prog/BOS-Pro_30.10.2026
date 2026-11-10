import http from 'node:http';
import type { Socket } from 'node:net';
import type { LocalApiResponse } from './local-task-api.js';

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type DispatchApi = {
  dispatch(token: unknown, raw: unknown): Promise<LocalApiResponse>;
};

export type LocalHttpServerOptions = {
  api: DispatchApi;
  /** Loopback only. Public bind addresses are rejected. */
  host?: '127.0.0.1';
  port?: number;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
};

export type LocalHttpListenInfo = { host: '127.0.0.1'; port: number };

/**
 * Explicit local HTTP transport over LocalTaskApi.
 * Importing this module does not open a port; call listen() from trusted bootstrap.
 * Browser Origin is rejected; CORS is not enabled at this stage.
 */
export class LocalHttpServer {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  private info: LocalHttpListenInfo | null = null;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly host: '127.0.0.1';
  private readonly port: number;

  constructor(private readonly options: LocalHttpServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    if (this.host !== '127.0.0.1') throw new Error('loopback_only');
    this.port = options.port ?? 0;
    if (!Number.isSafeInteger(this.port) || this.port < 0 || this.port > 65535) {
      throw new Error('invalid_listen_port');
    }
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1 || this.maxBodyBytes > MAX_BODY_BYTES) {
      throw new Error('invalid_body_limit');
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new Error('invalid_request_timeout');
    }
  }

  async listen(): Promise<LocalHttpListenInfo> {
    if (this.server) throw new Error('already_listening');
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    server.requestTimeout = this.requestTimeoutMs;
    server.headersTimeout = Math.min(this.requestTimeoutMs, 60_000);
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('listen_failed');
    }
    this.server = server;
    this.info = { host: this.host, port: address.port };
    return this.info;
  }

  address(): LocalHttpListenInfo | null {
    return this.info;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.info = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (!this.hostAllowed(req)) {
        this.send(res, 400, { code: 'invalid_host' });
        return;
      }
      if (req.headers.origin !== undefined && String(req.headers.origin).length > 0) {
        this.send(res, 403, { code: 'browser_origin_rejected' });
        return;
      }
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (req.method === 'GET' && path === '/health') {
        this.send(res, 200, { ok: true });
        return;
      }
      if (path === '/api/v1/dispatch') {
        if (req.method !== 'POST') {
          this.send(res, 405, { code: 'method_not_allowed' });
          return;
        }
        await this.dispatch(req, res);
        return;
      }
      this.send(res, 404, { code: 'not_found' });
    } catch {
      if (!res.headersSent) this.send(res, 500, { code: 'internal_error' });
      else res.destroy();
    }
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = bearerToken(req);
    if (token === null) {
      this.send(res, 401, { code: 'session_required' });
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (contentType !== 'application/json') {
      this.send(res, 415, { code: 'unsupported_media_type' });
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      this.send(res, 413, { code: 'request_too_large' });
      req.resume();
      return;
    }
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req, this.maxBodyBytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'request_too_large') {
        this.send(res, 413, { code: 'request_too_large' });
        return;
      }
      if (code === 'request_aborted' || code === 'request_timeout') {
        if (!res.headersSent) this.send(res, 408, { code: code });
        return;
      }
      this.send(res, 400, { code: 'invalid_request' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      this.send(res, 400, { code: 'invalid_json' });
      return;
    }
    const result = await this.options.api.dispatch(token, parsed);
    this.send(res, result.status, sanitizeBody(result.body));
  }

  private hostAllowed(req: http.IncomingMessage): boolean {
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
    const port = this.info?.port;
    if (port === undefined) return false;
    const allowed = new Set([
      '127.0.0.1',
      `127.0.0.1:${port}`,
      'localhost',
      `localhost:${port}`,
      '[::1]',
      `[::1]:${port}`,
    ]);
    return allowed.has(hostHeader.toLowerCase());
  }

  private send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': payload.byteLength,
      'cache-control': 'no-store',
    });
    res.end(payload);
  }
}

function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/.exec(header);
  return match?.[1] ?? null;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (code: string, destroy: boolean) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      if (destroy) req.destroy();
      else req.resume();
      reject(new Error(code));
    };
    req.on('aborted', () => fail('request_aborted', true));
    req.on('error', () => fail('request_aborted', true));
    req.on('timeout', () => fail('request_timeout', true));
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.byteLength;
      if (size > maxBytes) {
        // Keep the socket open long enough to send 413; drain the remainder.
        chunks.length = 0;
        fail('request_too_large', false);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
  });
}

/** Drop accidental secret-shaped fields before they leave the transport. */
function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(body);
  if (json.includes('postgres://') || json.includes('postgresql://')) {
    return { code: 'internal_error' };
  }
  return body;
}
