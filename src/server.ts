/**
 * 棋盘页的 HTTP 服务。只做三件事:给页面、报当前局面、收人的落子。
 *
 * 页面从包目录读(board.html),内联样式与脚本,没有构建步骤也没有外部依赖。
 * 轮询而不是 WebSocket:局面只有几百个格子,人机对局是秒级节奏,轮询够用,
 * 换来的是不用维护握手、重连和广播。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Position, Stone } from './game.ts';

const BOARD_HTML = fileURLToPath(new URL('./board.html', import.meta.url));

/** 人从网页做的一个动作。World 收到后变成事件或状态变化。 */
export interface BoardActions {
  /** 人落子。返回拒绝理由,`null` 表示已接受。 */
  place(col: number, row: number): Promise<string | null> | string | null;
  /** 人认输。返回拒绝理由,`null` 表示已接受。 */
  resign(): Promise<string | null> | string | null;
  /** 当前局面;还没有对局时为 null,页面据此显示「还没有对局」。 */
  snapshot(): BoardSnapshot | null;
}

/** 发给页面的局面快照。字段名与 board.html 里的读取一致。 */
export interface BoardSnapshot {
  size: number;
  cells: Array<Stone | null>;
  phase: string;
  turn: Stone | null;
  winner: Stone | null;
  lastMove: { col: number; row: number } | null;
  moves: number;
  /** 人在这一局执什么;没有对局时 null。 */
  youAre: Stone | null;
}

export interface BoardServerOptions {
  host: string;
  port: number;
  /** 人在这份部署里执哪一方;由 bot 开局时选,选完固定。 */
  humanStone: () => Stone | null;
  actions: BoardActions;
  log: (message: string) => void;
}

const MAX_BODY = 4096;

export class BoardServer {
  private server: Server | null = null;
  /** 实际绑定的端口;配置写 0 时由系统分配,必须从监听句柄读回来。 */
  private boundPort: number | null = null;

  constructor(private readonly opts: BoardServerOptions) {}

  /** 由第一个人执的一方决定;还没有对局时按黑棋展示(页面此时不显示棋盘内容)。 */
  private humanStone(): Stone | null {
    return this.opts.humanStone();
  }

  private snapshot(): BoardSnapshot | null {
    const p: Position | null = this.opts.actions.snapshot() as Position | null;
    if (!p || !('cells' in p)) return null;
    const youAre = this.humanStone();
    return {
      size: p.size,
      cells: p.cells.slice(),
      phase: p.phase,
      turn: p.turn,
      winner: p.phase === 'black-won' ? 'black' : p.phase === 'white-won' ? 'white' : null,
      lastMove: p.lastMove,
      moves: p.moves,
      youAre,
    };
  }

  /** 绑定端口并开始监听;绑不上时抛错,由 preflight 或 start 报给操作者。 */
  async listen(): Promise<void> {
    const html = readFileSync(BOARD_HTML);
    const server = createServer((req, res) => {
      this.handle(req, res, html).catch((error: unknown) => {
        this.send(res, 500, { error: `棋盘服务出错:${String(error)}` });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.opts.port, this.opts.host);
    });
    this.server = server;
    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : this.opts.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse, html: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.opts.host}:${this.port()}`);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && path === '/state') {
      this.send(res, 200, this.snapshot() ?? { none: true });
      return;
    }

    if (req.method === 'POST' && path === '/place') {
      const body = await readJson(req);
      const col = Number((body as { col?: unknown }).col);
      const row = Number((body as { row?: unknown }).row);
      if (!Number.isInteger(col) || !Number.isInteger(row)) {
        this.send(res, 400, { error: '坐标不是整数。' });
        return;
      }
      const reason = await this.opts.actions.place(col, row);
      if (reason) {
        this.send(res, 409, { error: reason });
        return;
      }
      this.send(res, 200, this.snapshot() ?? { none: true });
      return;
    }

    if (req.method === 'POST' && path === '/resign') {
      const reason = await this.opts.actions.resign();
      if (reason) {
        this.send(res, 409, { error: reason });
        return;
      }
      this.send(res, 200, this.snapshot() ?? { none: true });
      return;
    }

    this.send(res, 404, { error: '没有这个路径。' });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }

  /** 实际在听的端口;还没绑定时回配置值。 */
  private port(): number {
    return this.boundPort ?? this.opts.port;
  }

  /** 棋盘页在本机的地址,给事件正文、环境提示词与控制台链接用。 */
  url(): string {
    const host = this.opts.host === '0.0.0.0' || this.opts.host === '::' ? '127.0.0.1' : this.opts.host;
    return `http://${host}:${this.port()}/`;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY) throw new Error('请求体过大');
    chunks.push(buf);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return {};
  }
}
