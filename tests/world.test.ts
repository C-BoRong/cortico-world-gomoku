import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { GOMOKU } from '../src/definition.ts';
import { GOMOKU_DEFAULTS, validateGomokuConfig, type GomokuConfigSection } from '../src/config.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'gomoku-world-')); });
afterEach(() => { rmSync(scratchDir, { recursive: true, force: true }); });

/**
 * 起一个 World 并在一个空闲端口上监听。
 * 端口用 0 让系统分配,测试之间不会互相抢端口。
 */
async function boot(overrides: Partial<GomokuConfigSection> = {}) {
  const ctx = fakeWorldContext(GOMOKU, { scratchDir });
  Object.assign(ctx.cfg, { enabled: true, port: 0, ...overrides });
  const world = GOMOKU.create(ctx);
  const host = new FakeHost();
  await world.start(host);
  return { world, host, ctx };
}

function tool(world: { tools(): ToolDef[] }, name: string): ToolDef {
  const found = world.tools().find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

async function call(def: ToolDef, args: Record<string, unknown> = {}): Promise<string> {
  const result = await def.handler(args, {} as never);
  return typeof result === 'string' ? result : (result as ToolOutcome).text;
}

/** World 实际监听的端口,从 console 声明的链接里读。 */
function portOf(world: { console?: (l?: 'zh' | 'en') => { links?: Array<{ href: string }> } | undefined }): number {
  const href = world.console?.('zh')?.links?.[0]?.href;
  if (!href) throw new Error('no board link');
  return Number(new URL(href).port);
}

function boardUrl(world: Parameters<typeof portOf>[0], path: string): string {
  return `http://127.0.0.1:${portOf(world)}${path}`;
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 测试里把 A1 这类坐标转成页面 POST 的 {col,row}。 */
function coordToColRow(coord: string): { col: number; row: number } {
  const m = /^([A-Z])(\d+)$/.exec(coord);
  if (!m) throw new Error(`bad coord ${coord}`);
  return { col: m[1]!.charCodeAt(0) - 65, row: Number(m[2]) - 1 };
}

describe('干装载', () => {
  it('装载器接受它:假部署下能构造、能声明工具与环境变量', async () => {
    const report = await dryMountWorld(GOMOKU, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('配置组声明的路径都落在 defaults() 里', async () => {
    const report = await dryMountWorld(GOMOKU, { scratchDir });
    expect(report.failures.filter((f) => f.includes('配置组'))).toEqual([]);
  });

  it('未启用时也能以默认配置构造', () => {
    const world = GOMOKU.create(fakeWorldContext(GOMOKU, { scratchDir }));
    expect(world.tools().map((t) => t.name)).toEqual([
      'gomoku_start',
      'gomoku_place',
      'gomoku_resign',
      'gomoku_status',
    ]);
  });
});

describe('配置校验', () => {
  it('默认配置合法', () => {
    expect(validateGomokuConfig(GOMOKU_DEFAULTS)).toBeNull();
  });

  it('端口越界、连子数大于棋盘、未知坐标风格都被拒', () => {
    expect(validateGomokuConfig({ ...GOMOKU_DEFAULTS, port: 70000 })).toMatch(/端口/);
    expect(validateGomokuConfig({ ...GOMOKU_DEFAULTS, boardSize: 10, winLength: 11 })).toMatch(/连子数/);
    expect(validateGomokuConfig({ ...GOMOKU_DEFAULTS, coordStyle: 'zigzag' as never })).toMatch(/坐标记法/);
  });

  it('配置不合法时 preflight 抛错并给出原因', () => {
    const ctx = fakeWorldContext(GOMOKU, { scratchDir });
    Object.assign(ctx.cfg, { boardSize: 10, winLength: 11 });
    expect(() => GOMOKU.preflight?.(ctx)).toThrow(/连子数/);
  });
});

describe('挂载与事件', () => {
  it('挂载时投一条 gomoku.started,origin 是 internal', async () => {
    const { world, host } = await boot();
    expect(host.events.map((e) => e.type)).toEqual(['gomoku.started']);
    expect(host.events[0]!.origin).toBe('internal');
    expect(host.events[0]!.text).toContain('还没有对局');
    await world.stop();
  });

  it('端口被占用时启动失败,错误里带端口与出路', async () => {
    const first = await boot();
    const port = portOf(first.world);
    await expect(boot({ port })).rejects.toThrow(/绑不上/);
    await first.world.stop();
  });
});

describe('开局', () => {
  it('gomoku_start 选黑:人执白,且投一条 started 事件', async () => {
    const { world, host } = await boot();
    host.events.length = 0;
    const text = await call(tool(world, 'gomoku_start'), { stone: 'black' });
    expect(text).toContain('你执黑');
    expect(text).toContain('你先下');
    expect(host.events.map((e) => e.type)).toEqual(['gomoku.started']);
    await world.stop();
  });

  it('gomoku_start 选白:等人先落子', async () => {
    const { world } = await boot();
    const text = await call(tool(world, 'gomoku_start'), { stone: 'white' });
    expect(text).toContain('你执白');
    expect(text).toContain('等人先落子');
    await world.stop();
  });

  it('已有一局进行中时拒绝开新局,并报出当前局面', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    const text = await call(tool(world, 'gomoku_start'), { stone: 'white' });
    expect(text).toContain('已经有一局进行中');
    expect(text).toContain('H'); // 棋盘表头
    await world.stop();
  });

  it('stone 不是黑白时给失败回执', async () => {
    const { world } = await boot();
    const result = (await tool(world, 'gomoku_start').handler({ stone: 'red' }, {} as never)) as ToolOutcome;
    expect(result.failed).toBe(true);
    await world.stop();
  });
});

describe('落子', () => {
  it('没开局时落子被拒绝', async () => {
    const { world } = await boot();
    const result = (await tool(world, 'gomoku_place').handler({ coord: 'H8' }, {} as never)) as ToolOutcome;
    expect(result.failed).toBe(true);
    expect(result.text).toContain('还没有对局');
    await world.stop();
  });

  it('读不出的坐标给失败回执,并附上坐标怎么读', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    const result = (await tool(world, 'gomoku_place').handler({ coord: 'zzz' }, {} as never)) as ToolOutcome;
    expect(result.failed).toBe(true);
    expect(result.text).toContain('读不出坐标');
    expect(result.text).toContain('H8');
    await world.stop();
  });

  it('不是自己的回合时落子被拒绝', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'white' });
    const result = (await tool(world, 'gomoku_place').handler({ coord: 'H8' }, {} as never)) as ToolOutcome;
    expect(result.failed).toBe(true);
    expect(result.text).toContain('不是你的回合');
    await world.stop();
  });

  it('落子占位时回执说明这一格有子了', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    await call(tool(world, 'gomoku_place'), { coord: 'H8' });
    expect(await call(tool(world, 'gomoku_place'), { coord: 'H8' })).toContain('已经有子了');
    await world.stop();
  });

  it('按数字风格配置时,数字坐标也能落子', async () => {
    const { world } = await boot({ coordStyle: 'numeric' });
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    expect(await call(tool(world, 'gomoku_place'), { coord: '8,8' })).toContain('8,8');
    await world.stop();
  });
});

describe('人的动作经 HTTP 进入', () => {
  it('人在网页落子后投 gomoku.opponent_placed,origin 是 external,正文带棋盘', async () => {
    const { world, host } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'white' }); // 人执黑先下
    host.events.length = 0;

    const res = await postJson(boardUrl(world, '/place'), { col: 7, row: 7 });
    expect(res.status).toBe(200);
    expect(host.events.map((e) => e.type)).toEqual(['gomoku.opponent_placed']);
    expect(host.events[0]!.origin).toBe('external');
    expect(host.events[0]!.text).toContain('H8');
    expect(host.events[0]!.text).toContain('X'); // 棋盘渲染
    await world.stop();
  });

  it('不是人的回合时页面落子被拒,且不投事件', async () => {
    const { world, host } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' }); // 人执白
    host.events.length = 0;

    const res = await postJson(boardUrl(world, '/place'), { col: 7, row: 7 });
    expect(res.status).toBe(409);
    expect(host.events).toEqual([]);
    await world.stop();
  });

  it('坐标不是整数时回 400', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'white' });
    const res = await postJson(boardUrl(world, '/place'), { col: 'x', row: 1 });
    expect(res.status).toBe(400);
    await world.stop();
  });

  it('人认输判 bot 胜,并投 gomoku.ended', async () => {
    const { world, host } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'white' }); // 人执黑先下
    host.events.length = 0;

    const res = await fetch(boardUrl(world, '/resign'), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(host.events.map((e) => e.type)).toEqual(['gomoku.ended']);
    expect(host.events[0]!.text).toContain('人认输');
    await world.stop();
  });

  it('GET / 给出棋盘页,GET /state 给出局面', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });

    const page = await fetch(boardUrl(world, '/'));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<canvas');

    const state = await fetch(boardUrl(world, '/state'));
    const body = (await state.json()) as { size: number; youAre: string; phase: string };
    expect(body.size).toBe(15);
    expect(body.youAre).toBe('white');
    expect(body.phase).toBe('playing');
    await world.stop();
  });

  it('没有对局时 /state 报 none,页面照样能打开', async () => {
    const { world } = await boot();
    expect(await (await fetch(boardUrl(world, '/state'))).json()).toEqual({ none: true });
    expect((await fetch(boardUrl(world, '/'))).status).toBe(200);
    await world.stop();
  });

  it('未知路径回 404', async () => {
    const { world } = await boot();
    expect((await fetch(boardUrl(world, '/nope'))).status).toBe(404);
    await world.stop();
  });
});

describe('认输与终局', () => {
  it('bot 认输判人胜', async () => {
    const { world, host } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    host.events.length = 0;
    const text = await call(tool(world, 'gomoku_resign'));
    expect(text).toContain('你认输了');
    expect(host.events.map((e) => e.type)).toEqual(['gomoku.ended']);
    await world.stop();
  });

  it('不是自己的回合时不能认输', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'white' });
    const result = (await tool(world, 'gomoku_resign').handler({}, {} as never)) as ToolOutcome;
    expect(result.failed).toBe(true);
    await world.stop();
  });

  it('bot 连成五子获胜:投 ended,回执说明赢在哪', async () => {
    const { world, host } = await boot({ boardSize: 9 });
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    host.events.length = 0;

    const blackMoves = ['A1', 'B1', 'C1', 'D1', 'E1'];
    const whiteMoves = ['A9', 'B9', 'C9', 'D9'];
    for (let i = 0; i < 5; i += 1) {
      const text = await call(tool(world, 'gomoku_place'), { coord: blackMoves[i]! });
      if (i === 4) {
        expect(text).toContain('连成五子获胜');
        expect(text).toContain('五连在');
      }
      if (i < 4) {
        const res = await postJson(boardUrl(world, '/place'), coordToColRow(whiteMoves[i]!));
        expect(res.status).toBe(200);
      }
    }
    expect(host.events.map((e) => e.type)).toContain('gomoku.ended');
    expect(host.events.at(-1)!.text).toContain('获胜');
    await world.stop();
  });

  it('人连成五子时,opponent_placed 里就点明结果', async () => {
    const { world, host } = await boot({ boardSize: 9 });
    await call(tool(world, 'gomoku_start'), { stone: 'white' }); // 人执黑先下
    host.events.length = 0;

    const humanMoves = ['A1', 'B1', 'C1', 'D1', 'E1'];
    const botMoves = ['A9', 'B9', 'C9', 'D9'];
    for (let i = 0; i < 5; i += 1) {
      const res = await postJson(boardUrl(world, '/place'), coordToColRow(humanMoves[i]!));
      expect(res.status).toBe(200);
      if (i < 4) await call(tool(world, 'gomoku_place'), { coord: botMoves[i]! });
    }
    const types = host.events.map((e) => e.type);
    expect(types).toContain('gomoku.opponent_placed');
    expect(types).toContain('gomoku.ended');
    // 制胜的那一手是最后一条 opponent_placed
    const lastOpponent = host.events.filter((e) => e.type === 'gomoku.opponent_placed').at(-1)!;
    expect(lastOpponent.text).toContain('获胜');
    expect(lastOpponent.origin).toBe('external');
    await world.stop();
  });

  it('终局后落子被拒并提示开新局', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    await call(tool(world, 'gomoku_resign'));
    const result = (await tool(world, 'gomoku_place').handler({ coord: 'H8' }, {} as never)) as ToolOutcome;
    expect(result.failed).toBe(true);
    expect(result.text).toContain('已经结束');
    await world.stop();
  });

  it('终局后可以开新局', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    await call(tool(world, 'gomoku_resign'));
    const text = await call(tool(world, 'gomoku_start'), { stone: 'white' });
    expect(text).toContain('新的一局开始');
    expect(text).toContain('你执白');
    await world.stop();
  });
});

describe('环境提示词与 console 声明', () => {
  it('envPromptVars 报规则、坐标读法与当前局面', async () => {
    const { world } = await boot();
    const vars = (await world.envPromptVars()) as Record<string, string>;
    expect(vars['gomoku.boardRule']).toContain('15 路');
    expect(vars['gomoku.boardRule']).toContain('5 子');
    expect(vars['gomoku.coordRule']).toContain('H8');
    expect(vars['gomoku.url']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(vars['gomoku.state']).toContain('还没有对局');
    await world.stop();
  });

  it('开局后 envPromptVars 的局面一句话跟上', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    const vars = (await world.envPromptVars()) as Record<string, string>;
    expect(vars['gomoku.state']).toContain('进行中');
    expect(vars['gomoku.state']).toContain('你执黑');
    await world.stop();
  });

  it('console() 声明配置组、棋盘链接与环境提示词文档', async () => {
    const { world } = await boot();
    const decl = world.console?.('zh');
    expect(decl?.config?.[0]?.id).toBe('world:gomoku');
    expect(decl?.links?.[0]?.label).toBe('打开棋盘');
    expect(decl?.links?.[0]?.href).toMatch(/^http:\/\//);
    expect(decl?.promptDocs?.[0]?.key).toBe('worlds.gomoku.envPrompt');
    await world.stop();
  });

  it('英文请求给英文链接标签', async () => {
    const { world } = await boot();
    expect(world.console?.('en')?.links?.[0]?.label).toBe('Open board');
    await world.stop();
  });

  it('configOptions 给出两种坐标记法,未知 kind 返回空数组', () => {
    expect(GOMOKU.configOptions?.('gomoku.coordStyle', 'zh')).toHaveLength(2);
    expect(GOMOKU.configOptions?.('gomoku.coordStyle', 'en')).toHaveLength(2);
    expect(GOMOKU.configOptions?.('other.kind', 'zh')).toEqual([]);
  });

  it('ENV_PROMPT 模板里的占位符都有对应的值', async () => {
    const { world } = await boot();
    const vars = (await world.envPromptVars()) as Record<string, string>;
    const text = readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
    const names = [...text.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(Object.keys(vars)).toContain(name);
    await world.stop();
  });
});

describe('关机核对', () => {
  it('没有对局时报已验证结束', async () => {
    const { world } = await boot();
    expect(world.shutdownVerification?.()[0]?.status).toBe('verified-ended');
    await world.stop();
  });

  it('有进行中的对局时报 still-live,并说清会丢', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    const check = world.shutdownVerification?.()[0];
    expect(check?.status).toBe('still-live');
    expect(check?.detail).toContain('进行中');
    expect(check?.manualAction).toContain('丢失');
    await world.stop();
  });
});

describe('stop 之后', () => {
  it('端口释放,棋盘页连不上', async () => {
    const { world } = await boot();
    const url = boardUrl(world, '/state');
    await world.stop();
    await expect(fetch(url)).rejects.toThrow();
  });

  it('stop 之后局面清空', async () => {
    const { world } = await boot();
    await call(tool(world, 'gomoku_start'), { stone: 'black' });
    await world.stop();
    const text = await call(tool(world, 'gomoku_status'));
    expect(text).toContain('还没有对局');
  });
});
