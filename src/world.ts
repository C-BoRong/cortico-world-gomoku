/**
 * Gomoku World:bot 与一局网页五子棋之间的唯一边界。
 *
 * 分工:人落子经 HTTP 进来,World 把它变成事件报给 Core;bot 的动作走工具。
 * 棋盘状态留在 World 内存里,不进 Memory —— World 从不写 Memory。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ToolDef, ToolOutcome, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import { explainCoord, formatCoord, parseCoord } from './coord.ts';
import { GOMOKU_CONFIG_GROUP, GOMOKU_COORD_OPTIONS, type GomokuConfigSection } from './config.ts';
import {
  createPosition,
  opponentOf,
  place,
  rejectReason,
  renderBoard,
  resign,
  winningLine,
  type Position,
  type Stone,
} from './game.ts';
import { BoardServer, type BoardSnapshot } from './server.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 落子被拒时给模型的回执措辞。这些是机械事实,不是判断。 */
const REJECT_TEXT: Record<string, string> = {
  'out-of-bounds': '这一格不在棋盘上。',
  occupied: '这一格已经有子了。',
  'game-over': '这一局已经结束了,先开新的一局。',
};

export interface GomokuWorldOptions {
  /** `worlds.gomoku` 的活引用。 */
  cfg: GomokuConfigSection;
  timezone: string;
}

export class GomokuWorld implements World {
  readonly id = 'gomoku';

  private host: WorldHost | null = null;
  private server: BoardServer | null = null;
  private position: Position | null = null;
  /** bot 执哪一方;null 表示还没有对局。 */
  private botStone: Stone | null = null;
  /** 认输方是不是 bot;终局回执据此说明谁认输。 */
  private resignedBy: Stone | null = null;

  constructor(private readonly opts: GomokuWorldOptions) {}

  // ── World 契约 ───────────────────────────────────────────────────────────

  /** 只报值;前缀文本一律来自 ENV_PROMPT.md 模板。 */
  envPromptVars(): Record<string, string> {
    const cfg = this.opts.cfg;
    const state = this.describeState();
    return {
      'gomoku.boardRule': `${cfg.boardSize} 路棋盘,横、竖、斜任一方向先连成 ${cfg.winLength} 子的一方获胜。`,
      'gomoku.coordRule': explainCoord(cfg.coordStyle, cfg.boardSize),
      'gomoku.url': this.boardUrl(),
      'gomoku.state': state,
    };
  }

  tools(): ToolDef[] {
    return [this.startTool(), this.placeTool(), this.resignTool(), this.statusTool()];
  }

  console(language?: Language): WorldConsoleDecl {
    const zh = (language ?? 'zh') !== 'en';
    return {
      config: [GOMOKU_CONFIG_GROUP],
      links: [{ label: zh ? '打开棋盘' : 'Open board', href: this.boardUrl() }],
      promptDocs: [
        {
          key: 'worlds.gomoku.envPrompt',
          title: zh ? 'Gomoku · 环境提示词' : 'Gomoku · environment prompt',
          description: zh
            ? 'Gomoku World 进 system 前缀的那一段。'
            : 'The Gomoku World segment of the system prefix.',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'gomoku.boardRule', description: zh ? '棋盘与胜负规则,来自配置。' : 'Board and win rule, from config.' },
            { name: 'gomoku.coordRule', description: zh ? '坐标怎么读,来自配置。' : 'How to read coordinates, from config.' },
            { name: 'gomoku.url', description: zh ? '人看棋盘的地址。' : 'Where the human watches the board.' },
            { name: 'gomoku.state', description: zh ? '此刻局面的一句话说明。' : 'One line on the current position.' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const cfg = this.opts.cfg;
    const server = new BoardServer({
      host: cfg.host,
      port: cfg.port,
      humanStone: () => (this.botStone ? opponentOf(this.botStone) : null),
      actions: {
        place: (col, row) => this.humanPlaces(col, row),
        resign: () => this.humanResigns(),
        snapshot: () => this.snapshotForPage(),
      },
      log: (message) => host.log.info?.(message),
    });
    try {
      await server.listen();
    } catch (error) {
      throw new Error(
        `棋盘网页绑不上 ${cfg.host}:${cfg.port}(${error instanceof Error ? error.message : String(error)})。` +
          '改 worlds.gomoku.port,或先腾出这个端口。',
      );
    }
    this.server = server;
    host.log.info?.(`Gomoku 棋盘页在 ${server.url()}`);
    if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
      host.log.warn?.(
        `棋盘页监听 ${cfg.host},不在回环地址上,且这一页不做认证:能连到 ${cfg.host}:${cfg.port} 的人都能替你落子。`,
      );
    }
    await host.pushEvent({
      type: 'gomoku.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `Gomoku World 已挂载。棋盘页在 ${server.url()},还没有对局;用 gomoku_start 开一局。`,
    });
  }

  async stop(): Promise<void> {
    await this.server?.close();
    this.server = null;
    this.host = null;
    this.position = null;
    this.botStone = null;
    this.resignedBy = null;
  }

  /** 停机前的只读快照:还有一局没下完时说清它没下完。 */
  shutdownVerification() {
    if (!this.position || this.position.phase !== 'playing') {
      return [
        {
          key: 'gomoku.game',
          label: '五子棋对局',
          status: 'verified-ended' as const,
          detail: this.position ? `最后一局已结束(${this.position.phase})。` : '没有进行中的对局。',
          manualAction: '无。',
        },
      ];
    }
    return [
      {
        key: 'gomoku.game',
        label: '五子棋对局',
        status: 'still-live' as const,
        detail: `有一局进行中,已下 ${this.position.moves} 手,轮到 ${this.position.turn === 'black' ? '黑' : '白'}。`,
        manualAction: '这一局会随进程结束而丢失;要留着就等它下完。',
      },
    ];
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────

  private startTool(): ToolDef {
    const cfg = this.opts.cfg;
    return {
      name: 'gomoku_start',
      description:
        `开一局新的五子棋,并选定你执黑还是执白。执黑先下。` +
        `已有一局进行中时这一调用会被拒绝,不会丢弃那一局;要先结束它。` +
        `开局后人在棋盘页落子,你收到 gomoku.opponent_placed 事件。` +
        `棋盘 ${cfg.boardSize} 路,连 ${cfg.winLength} 子获胜。`,
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stone: {
            type: 'string',
            enum: ['black', 'white'],
            description: '你执哪一方。black 先下。',
          },
        },
        required: ['stone'],
      },
      handler: async (args) => this.doStart(args),
    };
  }

  private placeTool(): ToolDef {
    return {
      name: 'gomoku_place',
      description:
        '在棋盘上落一子。坐标是「列,行」;具体写法由部署配置决定,见环境提示词。' +
        '只在你轮到时能落子,不是你的回合、格子被占或这一局已结束时都会被拒绝。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          coord: {
            type: 'string',
            description: '落点,如 H8 或 8,8。',
          },
        },
        required: ['coord'],
      },
      handler: async (args) => this.doPlace(args),
    };
  }

  private resignTool(): ToolDef {
    return {
      name: 'gomoku_resign',
      description: '认输,这一局判对手胜并结束。只在轮到你、且局面还在进行时可用。',
      tags: ['write'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => this.doResign(),
    };
  }

  private statusTool(): ToolDef {
    return {
      name: 'gomoku_status',
      description:
        '读当前局面的完整快照:棋盘、轮谁下、这一局的状态。轮到你时你本来就会收到事件;' +
        '不确定局面、或想重新看一遍棋盘时用它。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => this.doStatus(),
    };
  }

  // ── 工具实现 ─────────────────────────────────────────────────────────────

  private async doStart(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const stone = String(args.stone ?? '');
    if (stone !== 'black' && stone !== 'white') {
      return { text: 'stone 只能是 black 或 white。', failed: true };
    }
    if (this.position && this.position.phase === 'playing') {
      return {
        text:
          `已经有一局进行中(已下 ${this.position.moves} 手,轮到 ${this.turnName()}),没有开新局。` +
          '要先结束它:下到分出胜负,或用 gomoku_resign 认输。\n\n' +
          this.renderPosition(),
      };
    }

    const cfg = this.opts.cfg;
    const human = opponentOf(stone);
    this.botStone = stone;
    this.resignedBy = null;
    this.position = createPosition(cfg.boardSize, cfg.winLength, 'black');

    await this.pushEvent(
      'gomoku.started',
      `新的一局开始。你执${stone === 'black' ? '黑' : '白'},人执${human === 'black' ? '黑' : '白'}。` +
        `${this.position.turn === stone ? '你先下。' : '等人先在棋盘页落子。'}棋盘页:${this.boardUrl()}`,
      'internal',
    );

    const lines = [
      `新的一局开始。你执${stone === 'black' ? '黑' : '白'},人执${human === 'black' ? '黑' : '白'}。`,
      `棋盘页:${this.boardUrl()}`,
    ];
    if (this.position.turn === stone) {
      lines.push('你先下,用 gomoku_place。');
    } else {
      lines.push('等人先落子;他落子后你会收到 gomoku.opponent_placed 事件。');
    }
    if (this.opts.cfg.autoOpen) this.openBoard();
    return lines.join('\n') + '\n\n' + this.renderPosition();
  }

  private async doPlace(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const p = this.position;
    if (!p || !this.botStone) {
      return { text: '还没有对局。先用 gomoku_start 开一局。', failed: true };
    }
    const coordText = String(args.coord ?? '').trim();
    const coord = parseCoord(coordText, p.size);
    if (!coord) {
      return {
        text: `读不出坐标「${coordText}」。${explainCoord(this.opts.cfg.coordStyle, p.size)}`,
        failed: true,
      };
    }
    const reason = rejectReason(p, coord.col, coord.row);
    if (reason) {
      return { text: `${REJECT_TEXT[reason] ?? reason}\n\n${this.renderPosition()}`, failed: true };
    }
    if (p.turn !== this.botStone) {
      return { text: `现在不是你的回合,轮到${p.turn === 'black' ? '黑' : '白'}。`, failed: true };
    }

    this.position = place(p, coord.col, coord.row);
    const next = this.position;
    const at = formatCoord(coord.col, coord.row, this.opts.cfg.coordStyle);

    if (next.phase !== 'playing') {
      await this.pushEvent('gomoku.ended', this.endedText(next), 'internal');
      return `你在 ${at} 落子。${this.endedText(next)}\n\n${this.renderPosition()}`;
    }
    return `你在 ${at} 落子。现在轮${next.turn === 'black' ? '黑' : '白'}。等人回应。`;
  }

  private async doResign(): Promise<string | ToolOutcome> {
    const p = this.position;
    if (!p || !this.botStone) return { text: '还没有对局。', failed: true };
    if (p.phase !== 'playing') return { text: `这一局已经结束了(${this.phaseText()})。`, failed: true };
    if (p.turn !== this.botStone) {
      return { text: `现在不是你的回合,轮到${p.turn === 'black' ? '黑' : '白'};等对面落子后再决定。`, failed: true };
    }
    const next = resign(p);
    this.position = next;
    this.resignedBy = this.botStone;
    await this.pushEvent('gomoku.ended', `你认输,这一局判人胜。`, 'internal');
    return `你认输了,这一局判人胜。\n\n${this.renderPosition()}`;
  }

  private async doStatus(): Promise<string> {
    if (!this.position || !this.botStone) {
      return `还没有对局。用 gomoku_start 开一局。棋盘页:${this.boardUrl()}`;
    }
    return this.renderPosition();
  }

  // ── 人的动作(网页进来的)─────────────────────────────────────────────────

  /** 人在网页落子。返回拒绝理由,`null` 表示已接受。 */
  private async humanPlaces(col: number, row: number): Promise<string | null> {
    const p = this.position;
    if (!p || !this.botStone) return '还没有对局;先让 bot 开一局。';
    const human = opponentOf(this.botStone);
    const reason = rejectReason(p, col, row);
    if (reason) return REJECT_TEXT[reason] ?? reason;
    if (p.turn !== human) return '现在不是你的回合。';

    this.position = place(p, col, row);
    const next = this.position;
    const at = formatCoord(col, row, this.opts.cfg.coordStyle);

    if (next.phase !== 'playing') {
      await this.pushEvent('gomoku.opponent_placed', `人在 ${at} 落子。${this.endedText(next)}`, 'external');
      await this.pushEvent('gomoku.ended', this.endedText(next), 'internal');
    } else {
      await this.pushEvent(
        'gomoku.opponent_placed',
        `人在 ${at} 落子。轮到你。\n\n${renderBoard(next, (c, r) => formatCoord(c, r, this.opts.cfg.coordStyle))}`,
        'external',
      );
    }
    return null;
  }

  /** 人在网页认输。返回拒绝理由,`null` 表示已接受。 */
  private async humanResigns(): Promise<string | null> {
    const p = this.position;
    if (!p || !this.botStone) return '还没有对局。';
    if (p.phase !== 'playing') return '这一局已经结束了。';
    const human = opponentOf(this.botStone);
    if (p.turn !== human) return '现在不是你的回合。';

    this.position = resign(p);
    this.resignedBy = human;
    await this.pushEvent('gomoku.ended', '人认输,这一局判你胜。', 'internal');
    return null;
  }

  /** 页面拿到的快照。还没有对局时用一个空棋盘,让页面先把格子画出来。 */
  private snapshotForPage(): BoardSnapshot | null {
    const p = this.position;
    if (!p || !this.botStone) return null;
    return {
      size: p.size,
      cells: p.cells.slice(),
      phase: p.phase,
      turn: p.turn,
      winner: p.phase === 'black-won' ? 'black' : p.phase === 'white-won' ? 'white' : null,
      lastMove: p.lastMove,
      moves: p.moves,
      youAre: opponentOf(this.botStone),
    };
  }

  // ── 共用 ─────────────────────────────────────────────────────────────────

  private boardUrl(): string {
    if (this.server) return this.server.url();
    const cfg = this.opts.cfg;
    const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    return `http://${host}:${cfg.port}/`;
  }

  /**
   * 投一条事件。人的落子用 flush:五子棋是回合制,人落子后轮到 bot 想棋,
   * 这一条不该等合批。人的落子也不打断 bot 已经开始的思考,所以不用 preempt。
   */
  private async pushEvent(type: string, text: string, origin: 'internal' | 'external'): Promise<void> {
    const host = this.host;
    if (!host) return;
    await host.pushEvent({
      type,
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin,
      senderKey: this.id,
      text,
    });
  }

  private turnName(): string {
    const t = this.position?.turn;
    return t ? (t === 'black' ? '黑' : '白') : '无人';
  }

  private phaseText(): string {
    const p = this.position;
    if (!p) return '还没有对局';
    switch (p.phase) {
      case 'playing':
        return `进行中,已下 ${p.moves} 手,轮到${this.turnName()}`;
      case 'black-won':
        return this.winText('black');
      case 'white-won':
        return this.winText('white');
      case 'draw':
        return '平局,棋盘已满';
      case 'resigned':
        return '认输结束';
    }
  }

  private winText(winner: Stone): string {
    const who = winner === this.botStone ? '你' : '人';
    return `${winner === 'black' ? '黑' : '白'}棋(${who})胜`;
  }

  /** 终局的一句话,只说可确认的事实:谁胜、赢在哪。 */
  private endedText(p: Position): string {
    if (p.phase === 'draw') return '棋盘已满,平局。';
    const winner: Stone = p.phase === 'black-won' ? 'black' : 'white';
    if (this.resignedBy) {
      const loser = this.resignedBy;
      return `${loser === this.botStone ? '你' : '人'}认输,${winner === this.botStone ? '你' : '人'}胜。`;
    }
    const line = winningLine(p);
    const where = line && line.length
      ? `五连在 ${line.map((c) => formatCoord(c.col, c.row, this.opts.cfg.coordStyle)).join(' ')}。`
      : '';
    return `${winner === 'black' ? '黑' : '白'}棋(${winner === this.botStone ? '你' : '人'})连成五子获胜。${where}`;
  }

  /** 局面的完整文本:状态一行,再加棋盘。 */
  private renderPosition(): string {
    const p = this.position;
    if (!p) return '还没有对局。';
    return `${this.phaseText()}。\n\n${renderBoard(p, (c, r) => formatCoord(c, r, this.opts.cfg.coordStyle))}`;
  }

  /** 环境提示词里的局面一句话。 */
  private describeState(): string {
    const p = this.position;
    if (!p || !this.botStone) return '此刻还没有对局。';
    return `此刻:${this.phaseText()}。你执${this.botStone === 'black' ? '黑' : '白'}。`;
  }

  /** 用系统默认浏览器打开棋盘页。打不开不算错,只记一条日志。 */
  private openBoard(): void {
    const url = this.boardUrl();
    const cmd =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    try {
      // 这一进程只为打开一个 URL,输出丢掉,失败也不影响 World。
      const child = spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (error) {
      this.host?.log.warn?.(`打开棋盘页失败:${String(error)}`);
    }
  }
}

/** 供 configOptions 之外的调用方拿选项;框架经 definition.ts 调。 */
export { GOMOKU_COORD_OPTIONS };
