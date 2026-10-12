import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GameStore, GameError } from '../src/game.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gomoku-game-')); });
afterEach(() => { if (!resolve(dir).startsWith(resolve(tmpdir()))) throw new Error('Invalid cleanup path'); rmSync(dir, { recursive: true, force: true }); });
const defaults = { botColor: 'white' as const, forbiddenEnabled: true, maxHistoryGames: 2 };
function store(file = join(dir, 'state.json')) { return new GameStore(file, () => defaults, () => '2026-10-12T12:00:00+08:00'); }
function act(s: GameStore, action: string, args: Record<string, unknown> = {}, actor: 'human' | 'bot' = 'human') { return s.apply({ action, revision: s.snapshot().revision, ...args }, actor); }

 describe('game state and persistence', () => {
  it('enforces identities, turns, coordinates and revisions without changing rejected state', () => {
    const s = store(); act(s, 'start');
    const before = s.snapshot();
    expect(() => act(s, 'move', { x: 7, y: 7 }, 'bot')).toThrow('当前轮到');
    expect(() => act(s, 'move', { x: 15, y: 0 })).toThrow('列坐标');
    expect(s.snapshot()).toEqual(before);
    act(s, 'move', { x: 7, y: 7 });
    expect(() => s.apply({ action: 'move', x: 1, y: 1, revision: before.revision }, 'bot')).toThrow(GameError);
    act(s, 'move', { x: 7, y: 8 }, 'bot');
    expect(s.snapshot().game.moves.map(m => [m.color, m.actor])).toEqual([['black', 'human'], ['white', 'bot']]);
    expect(() => act(s, 'color', { botColor: 'black' }, 'bot')).toThrow('开始落子后');
  });
  it('distinguishes a help request from an actual assisted move', () => {
    const s = store(); act(s, 'start'); act(s, 'assist');
    expect(s.snapshot().game.moves).toHaveLength(0);
    const change = act(s, 'assist', { x: 0, y: 0 }, 'bot');
    expect(change.type).toBe('move');
    expect(s.snapshot().game.moves[0]).toMatchObject({ color: 'black', actor: 'assist' });
    expect(() => act(s, 'assist', { x: 1, y: 1 }, 'bot')).toThrow('当前轮到');
  });
  it('allows sides and rules to change only before the first move', () => {
    const s = store(); act(s, 'start'); act(s, 'color', { botColor: 'black' }, 'bot');
    act(s, 'rules', { forbiddenEnabled: false }, 'bot');
    act(s, 'move', { x: 0, y: 0 }, 'bot');
    expect(() => act(s, 'rules', { forbiddenEnabled: true }, 'bot')).toThrow('开始落子后');
    expect(s.snapshot().game.forbiddenEnabled).toBe(false);
  });
  it('declares victory, refuses later moves, and reopens the board after undo', () => {
    const s = store(); act(s, 'start', { forbiddenEnabled: false });
    for (let x = 0; x < 4; x++) { act(s, 'move', { x, y: 0 }); act(s, 'move', { x, y: 2 }, 'bot'); }
    act(s, 'move', { x: 4, y: 0 });
    expect(s.snapshot().game).toMatchObject({ status: 'won', winner: 'black' });
    expect(s.snapshot().game.winningLine).toHaveLength(5);
    expect(() => act(s, 'move', { x: 4, y: 2 }, 'bot')).toThrow('结束后');
    act(s, 'undo', { count: 1 });
    expect(s.snapshot().game).toMatchObject({ status: 'playing', winner: null, turn: 'black' });
    expect(s.snapshot().game.board[0][4]).toBeNull();
  });
  it('undoes a full pair and preserves an audit of removed moves', () => {
    const s = store(); act(s, 'start'); act(s, 'move', { x: 1, y: 1 }); act(s, 'move', { x: 2, y: 2 }, 'bot');
    act(s, 'undo', { count: 2 });
    expect(s.snapshot().game.moves).toEqual([]);
    expect(s.snapshot().game.turn).toBe('black');
    expect(s.snapshot().game.actions.at(-1)?.detail).toContain('B2');
    expect(() => act(s, 'undo', { count: 1 })).toThrow('没有可以');
  });
  it('resignation awards the other side and clearing archives instead of deleting records', () => {
    const s = store(); act(s, 'start'); act(s, 'resign', {}, 'bot');
    expect(s.snapshot().game).toMatchObject({ status: 'resigned', winner: 'black' });
    const id = s.snapshot().game.id; act(s, 'clear');
    expect(s.snapshot().game.status).toBe('idle');
    expect(s.exportGame(id!)).toMatchObject({ winner: 'black', status: 'resigned' });
  });
  it('retains the newest configured number of games and restores current board', () => {
    const s = store(); act(s, 'start');
    for (let i = 0; i < 3; i++) act(s, 'start');
    act(s, 'move', { x: 14, y: 14 });
    expect(s.snapshot().history).toHaveLength(2);
    const restored = store(); restored.load(); expect(restored.snapshot()).toEqual(s.snapshot());
  });
  it('rolls back an operation when persistence fails', () => {
    mkdirSync(join(dir, 'target'));
    const s = store(join(dir, 'target')); const before = s.snapshot();
    expect(() => act(s, 'start')).toThrow();
    expect(s.snapshot()).toEqual(before);
  });
  it('reports corrupted records without overwriting the file', () => {
    const s = store(); act(s, 'start');
    const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    saved.game.board[0][0] = 'black'; const content = JSON.stringify(saved);
    writeFileSync(join(dir, 'state.json'), content);
    expect(() => store().load()).toThrow('存档格式');
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(content);
  });
  it('declares a draw when all 225 legal intersections are filled without a five', () => {
    const s = store(); act(s, 'start', { forbiddenEnabled: false });
    const black: Array<{ x: number; y: number }> = [], white: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) ((x + 2 * y) % 4 < 2 ? black : white).push({ x, y });
    expect(black).toHaveLength(113); expect(white).toHaveLength(112);
    for (let i = 0; i < 112; i++) { act(s, 'move', black[i]); act(s, 'move', white[i], 'bot'); }
    act(s, 'move', black[112]);
    expect(s.snapshot().game).toMatchObject({ status: 'draw', winner: null });
    expect(s.snapshot().game.moves).toHaveLength(225);
  });
  it('rejects a real double-three with a readable reason and leaves board and revision unchanged', () => {
    const s = store(); act(s, 'start');
    const black = [{ x: 6, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 6 }, { x: 7, y: 8 }];
    for (let i = 0; i < black.length; i++) { act(s, 'move', black[i]); act(s, 'move', { x: 2 * i, y: 0 }, 'bot'); }
    const before = s.snapshot();
    expect(() => act(s, 'move', { x: 7, y: 7 })).toThrow('双三禁手');
    expect(s.snapshot()).toEqual(before);
  });
});

