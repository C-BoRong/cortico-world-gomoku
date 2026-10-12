import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, ToolCallContext, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldContext } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import { gomokuConfigGroup, type GomokuConfigSection } from './config.ts';
import { GameError, GameStore, gameText, type State } from './game.ts';
import { BoardServer } from './server.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const revisionProperty = { type: 'integer', minimum: 0, description: 'Revision from the latest gomoku_get_state or mutation result. Stale revisions are rejected.' };
const positionProperties = {
  column: { type: 'string', pattern: '^[A-Oa-o]$', description: 'Column A through O, left to right.' },
  row: { type: 'integer', minimum: 1, maximum: 15, description: 'Row 1 through 15, top to bottom.' },
};

export class GomokuWorld implements World {
  readonly id = 'gomoku';
  private readonly store: GameStore;
  private readonly server: BoardServer;
  private host: WorldHost | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private stopping = false;
  constructor(private readonly ctx: WorldContext<GomokuConfigSection>) {
    this.store = new GameStore(join(ctx.dataDir, 'gomoku', 'state.json'), () => ctx.cfg, () => nowIso(ctx.timezone));
    this.server = new BoardServer(this.store, (args) => this.perform(args, 'human'));
  }
  get url(): string { return this.server.url; }
  getState(): State { return this.store.snapshot(); }

  envPromptVars(): Record<string, string> {
    return { 'gomoku.url': this.url || '(World is stopped)', 'gomoku.botColor': this.store.snapshot().game.botColor };
  }
  console(language: Language = 'zh'): WorldConsoleDecl {
    const zh = language === 'zh' || language === 'zh-Hant';
    const state = this.store.snapshot();
    return {
      label: zh ? '五子棋' : 'Gomoku',
      lamps: [{ label: zh ? '棋盘网页' : 'Board', state: this.url ? 'online' : 'offline', hint: this.url || (zh ? 'World 尚未启动' : 'World is stopped') }],
      badges: [{ label: zh ? '对局' : 'Game', value: state.game.status }, { label: zh ? '手数' : 'Moves', value: state.game.moves.length }],
      links: this.url ? [{ label: zh ? '打开五子棋棋盘' : 'Open Gomoku board', href: this.url }] : [],
      config: [gomokuConfigGroup(language)],
      promptDocs: [{ key: 'worlds.gomoku.envPrompt', title: zh ? '五子棋 · 环境描述' : 'Gomoku environment', description: zh ? '棋盘坐标、对弈规则和代落子约束。' : 'Coordinates, game rules and assisted moves.', path: ENV_PROMPT_FILE, role: 'envPrompt',
        vars: [{ name: 'gomoku.url', description: 'Board URL' }, { name: 'gomoku.botColor', description: 'Bot color in the current game' }] }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    if (this.host) return;
    const cfg = this.ctx.cfg;
    if (cfg.botColor !== 'black' && cfg.botColor !== 'white') throw new Error('五子棋默认棋色必须为 black 或 white。');
    if (typeof cfg.forbiddenEnabled !== 'boolean') throw new Error('五子棋禁手配置必须为布尔值。');
    if (!Number.isInteger(cfg.maxHistoryGames) || cfg.maxHistoryGames < 1 || cfg.maxHistoryGames > 1000) throw new Error('五子棋历史保留数必须为 1 到 1000 的整数。');
    this.store.load(); this.stopping = false;
    await this.server.start(this.ctx.cfg.host, this.ctx.cfg.port);
    this.host = host;
    await this.emit('online', `五子棋网页已启动：${this.url}。${this.store.snapshot().game.id ? ' 已恢复保存的对局。' : ' 尚未开局。'}`, 'internal', true);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await this.tail;
    await this.server.stop();
    if (this.host) await this.emit('offline', '五子棋网页已停止，棋局和记录已保存在部署数据目录。', 'internal', false);
    this.host = null;
  }

  tools(): ToolDef[] {
    const read = (name: string, description: string, properties: Record<string, unknown>, handler: (args: Record<string, unknown>) => string): ToolDef => ({
      name, description, tags: ['read', 'snapshot'], parameters: { type: 'object', additionalProperties: false, properties, required: [] },
      handler: async (args) => { try { return handler(args); } catch (error) { return { text: errorText(error), failed: true }; } },
    });
    return [
      read('gomoku_get_state', 'Read the entire 15×15 board, current turn, bot color, rules, game result, move list and revision. X=black, O=white.', {}, () => this.receipt()),
      read('gomoku_get_history', 'Read saved games and their move/action records. Omit gameId for the game list; use current for the current game.',
        { gameId: { type: 'string', description: 'current or a saved game UUID.' } }, (args) => {
          if (typeof args.gameId === 'string') return gameText(this.store.exportGame(args.gameId));
          return JSON.stringify(this.store.snapshot().history.map(({ id, status, winner, botColor, forbiddenEnabled, startedAt, endedAt, moves }) =>
            ({ id, status, winner, botColor, forbiddenEnabled, startedAt, endedAt, moveCount: moves.length })));
        }),
      this.mutation('gomoku_start', 'Start a new game, choosing your side and forbidden-move setting. Archives any existing game. Black moves first.', 'start',
        { botColor: { type: 'string', enum: ['black', 'white'] }, forbiddenEnabled: { type: 'boolean' } }, ['botColor', 'forbiddenEnabled']),
      this.mutation('gomoku_choose_color', 'Change your side before the first move in an active game. Rejected after any move.', 'color',
        { botColor: { type: 'string', enum: ['black', 'white'] } }, ['botColor']),
      this.mutation('gomoku_set_rules', 'Enable or disable Renju forbidden moves before the first move. Rejected after any move.', 'rules',
        { forbiddenEnabled: { type: 'boolean' } }, ['forbiddenEnabled']),
      this.mutation('gomoku_move', 'Place your stone at column/row on your turn. Rejects occupied intersections, forbidden moves and stale revisions. Returns the updated board and result.', 'move', positionProperties, ['column', 'row']),
      this.mutation('gomoku_assist', 'Explicitly place one stone for the human side on their turn. Use when the human asks for help. All turn and forbidden-move rules still apply.', 'assist', positionProperties, ['column', 'row']),
      this.mutation('gomoku_undo', 'Remove the last one or two moves; restores the turn and can reopen a completed game. Returns removed moves and updated board.', 'undo',
        { count: { type: 'integer', enum: [1, 2] } }, ['count']),
      this.mutation('gomoku_resign', 'Resign your own side in an active game. Awards victory to the human side.', 'resign', {}, []),
      this.mutation('gomoku_clear', 'Archive the current game and clear the board. Leaves no active game; saved records remain available.', 'clear', {}, []),
    ];
  }

  private mutation(name: string, description: string, action: string, properties: Record<string, unknown>, required: string[]): ToolDef {
    return { name, description, tags: ['act'], barrierAfter: true,
      parameters: { type: 'object', additionalProperties: false, properties: { ...properties, revision: revisionProperty }, required: [...required, 'revision'] },
      handler: async (args, call: ToolCallContext) => {
        try {
          const input: Record<string, unknown> = { ...args, action };
          if (action === 'move' || action === 'assist') {
            if (typeof args.column !== 'string' || !/^[A-Oa-o]$/.test(args.column)) throw new GameError('列坐标必须为 A 到 O。');
            input.x = args.column.toUpperCase().charCodeAt(0) - 65;
            input.y = typeof args.row === 'number' ? args.row - 1 : NaN;
          }
          await this.perform(input, 'bot', call.signal);
          return this.receipt();
        } catch (error) { return { text: `${errorText(error)}\n${this.receipt()}`, failed: true }; }
      },
    };
  }

  private perform(args: Record<string, unknown>, actor: 'bot' | 'human', signal?: AbortSignal): Promise<State> {
    const operation = this.tail.then(async () => {
      if (!this.host || this.stopping) throw new GameError('World 尚未启动或正在停止。', 503);
      if (signal?.aborted) throw new GameError('操作已取消。');
      const change = this.store.apply(args, actor);
      this.server.broadcast();
      await this.emit(change.type, change.detail, 'external', actor === 'human');
      if (change.ended) await this.emit('ended', change.detail, 'external', false);
      return this.store.snapshot();
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  private async emit(type: string, detail: string, origin: 'internal' | 'external', deliver: boolean): Promise<void> {
    if (!this.host) return;
    const state = this.store.snapshot();
    try {
      await this.host.pushEvent({ type: `gomoku.${type}`, ts: nowIso(this.ctx.timezone), source: this.id, origin, senderKey: this.id,
        text: `${detail}\nrevision=${state.revision}\n${gameText(state.game)}`, meta: { revision: state.revision, gameId: state.game.id } },
        deliver ? { trigger: 'flush' } : { deliver: false });
    } catch (error) { this.host.log.error('五子棋事件投递失败；棋盘操作已保存。', { error: errorText(error) }); }
  }
  private receipt(): string { const state = this.store.snapshot(); return `revision=${state.revision}\n${gameText(state.game)}`; }
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

