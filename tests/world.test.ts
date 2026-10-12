import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import type { ToolCallContext } from 'cortico/core/types.ts';
import type { State, Game } from '../src/game.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { GOMOKU } from '../src/definition.ts';
import { GomokuWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

let dir: string; let world: GomokuWorld; let host: FakeHost;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gomoku-world-'));
  const ctx = fakeWorldContext(GOMOKU, { scratchDir: dir }); ctx.cfg.port = 0;
  world = GOMOKU.create(ctx) as GomokuWorld; host = new FakeHost();
});
afterEach(async () => {
  await world.stop();
  if (!resolve(dir).startsWith(resolve(tmpdir()))) throw new Error('Invalid cleanup path');
  rmSync(dir, { recursive: true, force: true });
});
async function action(body: Record<string, unknown>) {
  return fetch(world.url + 'api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: world.getState().revision, ...body }) });
}
async function tool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  return world.tools().find(t => t.name === name)!.handler({ revision: world.getState().revision, ...args }, { signal } as ToolCallContext);
}

describe('World and standalone HTTP board', () => {
  it('dry mounts with no secrets or network connections', async () => {
    const report = await dryMountWorld(GOMOKU, { scratchDir: dir });
    expect(report.failures).toEqual([]); expect(report.warnings).toEqual([]);
    expect(world.url).toBe('');
  });
  it('starts the independent board and supplies the actual URL in console and prompt', async () => {
    await world.start(host);
    expect((await fetch(world.url)).status).toBe(200);
    expect(await (await fetch(world.url)).text()).toContain('五子棋');
    expect(world.console().links?.[0].href).toBe(world.url);
    expect(world.envPromptVars()['gomoku.url']).toBe(world.url);
    expect(host.events[0]).toMatchObject({ type: 'gomoku.online', origin: 'internal' });
  });
  it('maps model A/O coordinates to the HTTP board and archives self-actions without waking', async () => {
    await world.start(host);
    expect((await action({ action: 'start', botColor: 'white', forbiddenEnabled: true })).status).toBe(200);
    expect((await action({ action: 'move', x: 0, y: 0 })).status).toBe(200);
    const result = await tool('gomoku_move', { column: 'O', row: 15 });
    expect(typeof result).toBe('string');
    const state = await (await fetch(world.url + 'api/state')).json() as State;
    expect(state.game.board[14][14]).toBe('white');
    expect(state.game.moves[1]).toMatchObject({ x: 14, y: 14, actor: 'bot' });
    expect(host.events.at(-1)?.type).toBe('gomoku.move');
    expect(host.pushOpts.at(-1)).toEqual({ deliver: false });
    expect(host.pushOpts[2]).toEqual({ trigger: 'flush' });
  });
  it('rejects concurrent stale requests and an aborted tool without extra stones', async () => {
    await world.start(host); await action({ action: 'start', botColor: 'white' });
    const revision = world.getState().revision;
    const responses = await Promise.all([action({ action: 'move', x: 1, y: 1, revision }), action({ action: 'move', x: 2, y: 2, revision })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const controller = new AbortController(); controller.abort();
    expect(await tool('gomoku_move', { column: 'C', row: 3 }, controller.signal)).toMatchObject({ failed: true });
    expect(world.getState().game.moves).toHaveLength(1);
  });
  it('protects writes from cross-site origins and invalid JSON', async () => {
    await world.start(host);
    const crossSite = await fetch(world.url + 'api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.test' }, body: JSON.stringify({ action: 'start', revision: 0 }) });
    expect(crossSite.status).toBe(403);
    const invalid = await fetch(world.url + 'api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(invalid.status).toBe(400); expect(world.getState().revision).toBe(0);
    const wrongHostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(world.url + 'api/state', { headers: { Host: 'elsewhere.test' } }, response => { response.resume(); resolve(response.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(wrongHostStatus).toBe(421);
    expect((await action({ action: 'rules', forbiddenEnabled: false })).status).toBe(400);
  });
  it('streams initial and updated states through SSE and closes the stream on stop', async () => {
    await world.start(host);
    const response = await fetch(world.url + 'api/events'); const reader = response.body!.getReader(); const decoder = new TextDecoder();
    const initial = await reader.read(); expect(decoder.decode(initial.value)).toContain('data:');
    await action({ action: 'start', botColor: 'black' });
    const update = await reader.read(); expect(decoder.decode(update.value)).toContain('"botColor":"black"');
    await world.stop(); expect((await reader.read()).done).toBe(true);
  });
  it('exports records and resumes the same game after World recreation', async () => {
    await world.start(host); await action({ action: 'start' }); await action({ action: 'move', x: 7, y: 7 });
    const state = world.getState();
    const json = await (await fetch(world.url + 'api/export?format=json')).json() as Game; expect(json.id).toBe(state.game.id);
    const txt = await (await fetch(world.url + 'api/export?format=txt')).text(); expect(txt).toContain('H8');
    expect((await fetch(world.url + 'api/export?game=missing')).status).toBe(404);
    await world.stop();
    const ctx = fakeWorldContext(GOMOKU, { scratchDir: dir }); ctx.cfg.port = 0;
    world = GOMOKU.create(ctx) as GomokuWorld; await world.start(host);
    expect(world.getState()).toEqual(state); expect(host.events.at(-1)?.text).toContain('已恢复');
  });
  it('reports a port conflict and releases the listening port when stopped', async () => {
    await world.start(host);
    const port = Number(new URL(world.url).port);
    const ctx = fakeWorldContext(GOMOKU, { scratchDir: dir }); ctx.cfg.port = port;
    const other = GOMOKU.create(ctx) as GomokuWorld;
    await expect(other.start(new FakeHost())).rejects.toThrow('已被占用');
    await world.stop(); await other.start(new FakeHost()); await other.stop();
  });
  it('keeps the board committed when host event reporting fails', async () => {
    await world.start(host); host.pushEvent = async () => { throw new Error('store unavailable'); };
    const response = await action({ action: 'start' }); expect(response.status).toBe(200);
    expect(world.getState().game.status).toBe('playing');
  });
  it('requires the bot to use the explicit assist tool on the human turn', async () => {
    await world.start(host); await action({ action: 'start' });
    expect(await tool('gomoku_move', { column: 'H', row: 8 })).toMatchObject({ failed: true });
    expect(typeof await tool('gomoku_assist', { column: 'H', row: 8 })).toBe('string');
    expect(world.getState().game.moves[0].actor).toBe('assist');
    expect(await tool('gomoku_move', { column: 'AA', row: 8 })).toMatchObject({ failed: true });
  });
});

