import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { analyzeMove, BOARD_SIZE, coordinate, createBoard, opposite, type Board, type Color } from './rules.ts';

export type Actor = 'bot' | 'human' | 'assist';
export type GameStatus = 'idle' | 'playing' | 'won' | 'draw' | 'resigned';
export interface Move { number: number; x: number; y: number; color: Color; actor: Actor; at: string }
export interface Game {
  id: string | null; status: GameStatus; botColor: Color; forbiddenEnabled: boolean;
  board: Board; turn: Color; moves: Move[]; winner: Color | null;
  winningLine: Array<{ x: number; y: number }>; startedAt: string | null; endedAt: string | null;
  actions: Array<{ kind: string; at: string; detail: string }>;
}
export interface State { revision: number; game: Game; history: Game[] }
export interface GameDefaults { botColor: Color; forbiddenEnabled: boolean; maxHistoryGames: number }
export interface Change { type: string; detail: string; ended: boolean }

export class GameError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function emptyGame(defaults: GameDefaults): Game {
  return { id: null, status: 'idle', botColor: defaults.botColor, forbiddenEnabled: defaults.forbiddenEnabled,
    board: createBoard(), turn: 'black', moves: [], winner: null, winningLine: [], startedAt: null, endedAt: null, actions: [] };
}

export class GameStore {
  private state: State;
  constructor(private readonly file: string, private readonly defaults: () => GameDefaults, private readonly now: () => string) {
    this.state = { revision: 0, game: emptyGame(defaults()), history: [] };
  }
  load(): void {
    if (!existsSync(this.file)) return;
    const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!isState(saved)) throw new Error('五子棋存档格式不正确，请保留原文件后检查 ' + this.file);
    this.state = saved;
  }
  snapshot(): State { return structuredClone(this.state); }
  apply(action: Record<string, unknown>, actor: 'human' | 'bot'): Change {
    if (!Number.isSafeInteger(action.revision) || action.revision !== this.state.revision) throw new GameError('棋盘已更新，请读取最新棋盘后再操作。', 409);
    const previous = structuredClone(this.state);
    try {
      const change = this.mutate(action, actor);
      this.state.revision++;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(this.file + '.tmp', this.file);
      return change;
    } catch (error) { this.state = previous; throw error; }
  }
  exportGame(id: string): Game {
    const game = id === 'current' ? this.state.game : this.state.history.find((item) => item.id === id);
    if (!game) throw new GameError('找不到这场对局。', 404);
    return structuredClone(game);
  }
  private mutate(action: Record<string, unknown>, actor: 'human' | 'bot'): Change {
    const game = this.state.game;
    const at = this.now();
    let type: string, detail: string;
    switch (action.action) {
      case 'start': {
        const botColor = color(action.botColor ?? this.defaults().botColor);
        const forbiddenEnabled = boolean(action.forbiddenEnabled ?? this.defaults().forbiddenEnabled);
        this.archive(at, '开始新对局');
        this.state.game = { ...emptyGame({ ...this.defaults(), botColor, forbiddenEnabled }), id: randomUUID(), status: 'playing', startedAt: at };
        type = 'started'; detail = `新对局：bot 执${colorName(botColor)}，黑先，禁手${forbiddenEnabled ? '开启' : '关闭'}。`;
        break;
      }
      case 'color':
        this.beforeFirstMove(); game.botColor = color(action.botColor);
        type = 'changed'; detail = `bot 改执${colorName(game.botColor)}。`; break;
      case 'rules':
        this.beforeFirstMove(); game.forbiddenEnabled = boolean(action.forbiddenEnabled);
        type = 'changed'; detail = `禁手${game.forbiddenEnabled ? '开启' : '关闭'}。`; break;
      case 'move':
      case 'assist': {
        this.playing();
        if (action.action === 'assist' && actor === 'human') {
          if (game.turn === game.botColor) throw new GameError('现在是 bot 的回合。');
          type = 'help'; detail = `人类请求 bot 帮${colorName(game.turn)}选择并落下一手。`; break;
        }
        const assisting = action.action === 'assist';
        const side = assisting || actor === 'human' ? opposite(game.botColor) : game.botColor;
        if (game.turn !== side) throw new GameError(`当前轮到${colorName(game.turn)}，不能替另一方落子。`);
        const x = integer(action.x, 0, BOARD_SIZE - 1, '列坐标');
        const y = integer(action.y, 0, BOARD_SIZE - 1, '行坐标');
        const result = analyzeMove(game.board, x, y, side, game.forbiddenEnabled);
        if (!result.legal) {
          const reasons = { overline: '黑方长连禁手：不能形成六枚或更多连珠。', 'double-four': '黑方双四禁手：这一手形成了两个或更多四。', 'double-three': '黑方双三禁手：这一手形成了两个或更多真活三。' };
          throw new GameError(result.forbidden ? reasons[result.forbidden] : result.reason ?? '不合法的落子。');
        }
        game.board[y][x] = side;
        const move: Move = { number: game.moves.length + 1, x, y, color: side, actor: assisting ? 'assist' : actor, at };
        game.moves.push(move); game.turn = opposite(side);
        if (result.winning) { game.status = 'won'; game.winner = side; game.winningLine = result.winningLine; game.endedAt = at; }
        else if (game.moves.length === BOARD_SIZE * BOARD_SIZE) { game.status = 'draw'; game.endedAt = at; }
        type = 'move'; detail = `第 ${move.number} 手：${colorName(side)} ${coordinate(x, y)}，${assisting ? 'bot 为人类代落子' : actor === 'bot' ? 'bot 落子' : '人类落子'}。`;
        if (game.status === 'won') detail += ` ${colorName(side)}连珠获胜。`;
        else if (game.status === 'draw') detail += ' 棋盘已满，平局。';
        break;
      }
      case 'undo': {
        if (!game.id || !game.moves.length) throw new GameError('没有可以撤销的落子。');
        const count = integer(action.count ?? 1, 1, 2, '悔棋步数');
        if (game.moves.length < count) throw new GameError(`当前只有 ${game.moves.length} 手，不能撤销 ${count} 手。`);
        const removed = game.moves.splice(-count);
        for (const move of removed) game.board[move.y][move.x] = null;
        game.turn = removed[0].color; game.status = 'playing'; game.winner = null; game.winningLine = []; game.endedAt = null;
        type = 'undo'; detail = `撤销 ${count} 手：${removed.map((m) => colorName(m.color) + ' ' + coordinate(m.x, m.y)).join('、')}。`; break;
      }
      case 'resign': {
        this.playing(); const side = actor === 'bot' ? game.botColor : opposite(game.botColor);
        game.status = 'resigned'; game.winner = opposite(side); game.endedAt = at;
        type = 'resigned'; detail = `${colorName(side)}认输，${colorName(game.winner)}获胜。`; break;
      }
      case 'clear':
        this.archive(at, '清空棋盘'); this.state.game = emptyGame(this.defaults());
        type = 'cleared'; detail = '棋盘已清空，上一局已保存到历史记录。'; break;
      default: throw new GameError('未知操作。');
    }
    this.state.game.actions.push({ kind: type, at, detail: `${actor === 'bot' ? 'bot' : '人类'}：${detail}` });
    return { type, detail, ended: ['won', 'draw', 'resigned'].includes(this.state.game.status) };
  }
  private playing(): void { if (this.state.game.status !== 'playing') throw new GameError('请先开始一局游戏；结束后可开新局或悔棋。'); }
  private beforeFirstMove(): void { this.playing(); if (this.state.game.moves.length) throw new GameError('开始落子后不能更改棋色或规则，请开新局。'); }
  private archive(at: string, reason: string): void {
    const game = this.state.game; if (!game.id) return;
    const archived = structuredClone(game); archived.endedAt ??= at;
    archived.actions.push({ kind: 'archived', at, detail: reason });
    this.state.history.unshift(archived); this.state.history.splice(this.defaults().maxHistoryGames);
  }
}

export function colorName(side: Color): string { return side === 'black' ? '黑方' : '白方'; }
export function color(value: unknown): Color {
  if (value !== 'black' && value !== 'white') throw new GameError('棋色必须是 black 或 white。'); return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new GameError('禁手开关必须为布尔值。'); return value; }
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new GameError(`${label}必须是 ${min} 到 ${max} 之间的整数。`); return value as number;
}
export function gameText(game: Game): string {
  const lines = [`五子棋 ${game.id ?? '尚未开局'}`, `状态 ${game.status} · bot ${colorName(game.botColor)} · 禁手${game.forbiddenEnabled ? '开' : '关'}`,
    `当前轮到 ${colorName(game.turn)}${game.winner ? ' · 获胜 ' + colorName(game.winner) : ''}`, '    A B C D E F G H I J K L M N O'];
  game.board.forEach((row, y) => lines.push(`${String(y + 1).padStart(2, ' ')}  ${row.map((cell) => cell === 'black' ? 'X' : cell === 'white' ? 'O' : '.').join(' ')}`));
  lines.push('X=黑，O=白，.=空', '', '落子记录');
  for (const move of game.moves) lines.push(`${move.number}. ${colorName(move.color)} ${coordinate(move.x, move.y)} [${move.actor}] ${move.at}`);
  lines.push('', '操作记录');
  for (const action of game.actions) lines.push(`${action.at} ${action.detail}`);
  return lines.join('\n');
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isColor(value: unknown): boolean { return value === 'black' || value === 'white'; }
function isGame(value: unknown): value is Game {
  if (!object(value) || !(value.id === null || typeof value.id === 'string') || !isColor(value.botColor) || !isColor(value.turn) || typeof value.forbiddenEnabled !== 'boolean') return false;
  if (!['idle', 'playing', 'won', 'draw', 'resigned'].includes(String(value.status)) || !(value.winner === null || isColor(value.winner))) return false;
  if (!(value.startedAt === null || typeof value.startedAt === 'string') || !(value.endedAt === null || typeof value.endedAt === 'string')) return false;
  if (!Array.isArray(value.board) || value.board.length !== BOARD_SIZE || !value.board.every((row) => Array.isArray(row) && row.length === BOARD_SIZE && row.every((cell) => cell === null || isColor(cell)))) return false;
  const point = (p: unknown) => object(p) && Number.isInteger(p.x) && Number.isInteger(p.y) && (p.x as number) >= 0 && (p.x as number) < BOARD_SIZE && (p.y as number) >= 0 && (p.y as number) < BOARD_SIZE;
  if (!Array.isArray(value.moves) || !value.moves.every((m, i) => point(m) && object(m) && m.number === i + 1 && isColor(m.color) && ['bot', 'human', 'assist'].includes(String(m.actor)) && typeof m.at === 'string')) return false;
  if (!Array.isArray(value.winningLine) || !value.winningLine.every(point) || !Array.isArray(value.actions) || !value.actions.every((a) => object(a) && typeof a.kind === 'string' && typeof a.at === 'string' && typeof a.detail === 'string')) return false;
  const replay = createBoard();
  for (const move of value.moves as Move[]) { if (replay[move.y][move.x] !== null) return false; replay[move.y][move.x] = move.color; }
  return JSON.stringify(replay) === JSON.stringify(value.board);
}
function isState(value: unknown): value is State {
  return object(value) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 && isGame(value.game) && Array.isArray(value.history) && value.history.every(isGame);
}

