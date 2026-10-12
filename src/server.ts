import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError, gameText, type GameStore, type State } from './game.ts';

const PAGE_FILE = fileURLToPath(new URL('../public/index.html', import.meta.url));
const HUMAN_ACTIONS = new Set(['start', 'move', 'assist', 'undo', 'resign', 'clear']);

export class BoardServer {
  private server: Server | null = null;
  private clients = new Set<ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private boundUrl = '';
  private allowedHostnames = new Set<string>();
  constructor(private readonly store: GameStore, private readonly action: (args: Record<string, unknown>) => Promise<State>) {}
  get url(): string { return this.boundUrl; }

  async start(host: string, port: number): Promise<void> {
    if (typeof host !== 'string' || !host.trim()) throw new Error('五子棋监听地址不能为空。');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('五子棋端口必须为 1 到 65535 的整数。');
    const page = readFileSync(PAGE_FILE);
    const server = createServer((req, res) => { void this.route(req, res, page).catch((error) => {
      if (res.headersSent) { res.end(); return; }
      this.json(res, error instanceof GameError ? error.status : 500, { error: error instanceof Error ? error.message : String(error), state: this.store.snapshot() });
    }); });
    server.requestTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') throw new Error(`五子棋端口 ${port} 已被占用，请在 World 配置中更改端口。`);
      throw error;
    });
    this.server = server;
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    const localHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    this.boundUrl = `http://${localHost.includes(':') ? '[' + localHost + ']' : localHost}:${actualPort}/`;
    this.allowedHostnames = new Set([host, localHost, 'localhost', '127.0.0.1', '[::1]']);
    if (host === '0.0.0.0' || host === '::') this.allowedHostnames.clear();
    this.heartbeat = setInterval(() => { for (const res of this.clients) res.write(': heartbeat\n\n'); }, 15000);
    this.heartbeat.unref();
  }

  broadcast(): void {
    const data = `data: ${JSON.stringify(this.store.snapshot())}\n\n`;
    for (const res of this.clients) {
      if (!res.write(data)) { this.clients.delete(res); res.end(); }
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
    const server = this.server; this.server = null; this.boundUrl = '';
    if (!server) return;
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); });
  }

  private async route(req: IncomingMessage, res: ServerResponse, page: Buffer): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const host = req.headers.host;
    if (!host) throw new GameError('缺少 Host。');
    const url = new URL(req.url ?? '/', 'http://' + host);
    if (this.allowedHostnames.size && !this.allowedHostnames.has(url.hostname)) throw new GameError('Host 与监听地址不一致。', 421);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
      res.end(page); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') { this.json(res, 200, this.store.snapshot()); return; }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (req.headers.origin && req.headers.origin !== 'http://' + host) throw new GameError('不允许跨站访问。', 403);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\ndata: ${JSON.stringify(this.store.snapshot())}\n\n`);
      this.clients.add(res); req.on('close', () => this.clients.delete(res)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const game = this.store.exportGame(url.searchParams.get('game') ?? 'current');
      const format = url.searchParams.get('format') ?? 'json';
      if (format !== 'json' && format !== 'txt') throw new GameError('只支持 JSON 或 TXT 导出。');
      res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="gomoku-${game.id ?? 'board'}.${format}"` });
      res.end(format === 'json' ? JSON.stringify(game, null, 2) : gameText(game)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (req.headers.origin && req.headers.origin !== 'http://' + host) throw new GameError('不允许跨站修改棋盘。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new GameError('不允许跨站修改棋盘。', 403);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new GameError('请求必须为 JSON。', 415);
      const body = await readJson(req);
      if (!HUMAN_ACTIONS.has(String(body.action))) throw new GameError('网页不支持该操作。');
      this.json(res, 200, await this.action(body)); return;
    }
    this.json(res, 404, { error: '找不到该页面。' });
  }
  private json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length; if (size > 16384) throw new GameError('请求过大。', 413); chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GameError('JSON 格式不正确。'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GameError('请求必须是对象。');
  return value as Record<string, unknown>;
}

