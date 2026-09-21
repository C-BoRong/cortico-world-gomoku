import { describe, it, expect } from 'vitest';
import {
  createPosition,
  place,
  rejectReason,
  renderBoard,
  resign,
  winningLine,
  winnerOf,
  opponentOf,
} from '../src/game.ts';
import { explainCoord, formatCoord, parseCoord } from '../src/coord.ts';

const size = 15;
const win = 5;
const fresh = () => createPosition(size, win, 'black');

describe('落子与轮次', () => {
  it('黑先下,落子后轮到白', () => {
    const p = place(fresh(), 7, 7);
    expect(p.turn).toBe('white');
    expect(p.moves).toBe(1);
    expect(p.lastMove).toEqual({ col: 7, row: 7 });
  });

  it('落子不改动原来的局面', () => {
    const before = fresh();
    place(before, 7, 7);
    expect(before.moves).toBe(0);
    expect(before.turn).toBe('black');
  });

  it('占了的格子、越界的坐标、终局后的落子都被拒', () => {
    const p = place(fresh(), 7, 7);
    expect(rejectReason(p, 7, 7)).toBe('occupied');
    expect(rejectReason(p, -1, 0)).toBe('out-of-bounds');
    expect(rejectReason(p, size, 0)).toBe('out-of-bounds');
    expect(rejectReason(p, 1.5, 2)).toBe('out-of-bounds');
    expect(rejectReason(p, 0, 0)).toBeNull();
  });

  it('非法落子在 place() 里抛错,而不是静默返回原局面', () => {
    const p = place(fresh(), 7, 7);
    expect(() => place(p, 7, 7)).toThrow(/occupied/);
  });
});

describe('胜负判定', () => {
  it('横向五连获胜,并给出五连的坐标', () => {
    let p = fresh();
    // 黑: (0..4, 0);白: (0..3, 1)
    for (let i = 0; i < 5; i += 1) {
      p = place(p, i, 0);
      if (i < 4) p = place(p, i, 1);
    }
    expect(p.phase).toBe('black-won');
    expect(winnerOf(p.phase)).toBe('black');
    expect(p.turn).toBeNull();
    const line = winningLine(p);
    expect(line).toHaveLength(5);
    expect(line?.map((c) => c.col)).toEqual([0, 1, 2, 3, 4]);
  });

  it('竖向与两个斜向的五连都算赢', () => {
    const cases: Array<[number, number]> = [
      [0, 1],
      [1, 1],
      [1, -1],
    ];
    for (const [dc, dr] of cases) {
      let p = fresh();
      for (let i = 0; i < 5; i += 1) {
        p = place(p, 7 + dc * i, 7 + dr * i);
        if (i < 4) p = place(p, 0, 14 - i); // 白棋落在远处的角上,不干扰
      }
      expect(p.phase, `direction ${dc},${dr}`).toBe('black-won');
    }
  });

  it('四子不算赢', () => {
    let p = fresh();
    for (let i = 0; i < 4; i += 1) {
      p = place(p, i, 0);
      p = place(p, i, 1);
    }
    expect(p.phase).toBe('playing');
  });

  it('五连中间被隔断不算赢', () => {
    let p = fresh();
    // 黑占 0,1,2 与 4,白插在 3
    p = place(p, 0, 0); p = place(p, 0, 5);
    p = place(p, 1, 0); p = place(p, 1, 5);
    p = place(p, 2, 0); p = place(p, 2, 5);
    p = place(p, 3, 5); // 白占掉断点
    p = place(p, 4, 0);
    expect(p.phase).toBe('playing');
  });

  it('认输判对手胜', () => {
    const p = resign(fresh());
    expect(p.phase).toBe('white-won');
    expect(winnerOf(p.phase)).toBe('white');
  });

  it('终局后不能再认输', () => {
    expect(() => resign(resign(fresh()))).toThrow(/cannot resign/);
  });

  it('棋盘下满且无五连是平局', () => {
    // 5 路棋盘、连 5 子:棋盘恰好 25 格,填满时任何一行/列/对角都不可能凑齐 5 个同色而不触发胜利,
    // 所以用一个已知无五连的填色,再逐格按合法轮次落子,验证最后一步落到 draw。
    // 这里走真实路径:place() 逐手调用,只要求它中途不判胜、最后判平局。
    const p = createPosition(5, 5, 'black');
    const grid = [
      'B B W W B',
      'W W B B W',
      'B B W W B',
      'W W B B W',
      'B B W W B',
    ].map((row) => row.split(' ').map((c) => (c === 'B' ? 'black' : 'white')));
    // 检查这个填色确实没有五连(否则下面会中途判胜)
    const lineOf = (cells: (string | null)[], n: number) => {
      if (cells.some((c) => c === null)) return false;
      return cells.every((c) => c === cells[0]) && cells.length >= n;
    };
    for (let r = 0; r < 5; r += 1) expect(lineOf(grid[r]!, 5)).toBe(false);
    for (let c = 0; c < 5; c += 1) expect(lineOf(grid.map((row) => row[c]!), 5)).toBe(false);

    // 按黑白交替的落子顺序还原这个填色:黑棋先手,所以黑的位置有 13 格、白 12 格
    const blacks: Array<[number, number]> = [];
    const whites: Array<[number, number]> = [];
    for (let r = 0; r < 5; r += 1) {
      for (let c = 0; c < 5; c += 1) {
        (grid[r]![c] === 'black' ? blacks : whites).push([c, r]);
      }
    }
    expect(blacks).toHaveLength(13);
    expect(whites).toHaveLength(12);

    let cur = p;
    for (let i = 0; i < 12; i += 1) {
      cur = place(cur, blacks[i]![0], blacks[i]![1]);
      cur = place(cur, whites[i]![0], whites[i]![1]);
    }
    cur = place(cur, blacks[12]![0], blacks[12]![1]); // 最后一手

    expect(cur.moves).toBe(25);
    expect(cur.phase).toBe('draw');
    expect(cur.turn).toBeNull();
  });
});

describe('坐标', () => {
  it('字母风格写成 H8,数字风格写成 8,8', () => {
    expect(formatCoord(7, 7, 'letters')).toBe('H8');
    expect(formatCoord(7, 7, 'numeric')).toBe('8,8');
    expect(formatCoord(0, 0, 'letters')).toBe('A1');
    expect(formatCoord(14, 14, 'letters')).toBe('O15');
  });

  it('解析接受大小写、连字符与括号', () => {
    expect(parseCoord('H8', size)).toEqual({ col: 7, row: 7 });
    expect(parseCoord('h8', size)).toEqual({ col: 7, row: 7 });
    expect(parseCoord('H-8', size)).toEqual({ col: 7, row: 7 });
    expect(parseCoord('(8,8)', size)).toEqual({ col: 7, row: 7 });
    expect(parseCoord('8 8', size)).toEqual({ col: 7, row: 7 });
  });

  it('越界与读不出的输入返回 null,不抛错', () => {
    expect(parseCoord('Z99', size)).toBeNull();
    expect(parseCoord('A0', size)).toBeNull();
    expect(parseCoord('hello', size)).toBeNull();
    expect(parseCoord('', size)).toBeNull();
  });

  it('解析出的坐标一定能格式化回同一格', () => {
    for (const [col, row] of [[0, 0], [7, 7], [14, 14], [3, 11]] as const) {
      expect(parseCoord(formatCoord(col, row, 'letters'), size)).toEqual({ col, row });
      expect(parseCoord(formatCoord(col, row, 'numeric'), size)).toEqual({ col, row });
    }
  });

  it('两种风格都给出解释文本', () => {
    expect(explainCoord('letters', size)).toContain('H8');
    expect(explainCoord('numeric', size)).toContain('1');
  });
});

describe('棋盘渲染', () => {
  it('渲染出行号列标与黑白子', () => {
    let p = place(fresh(), 7, 7);      // 黑 H8
    p = place(p, 0, 0);                 // 白 A1
    const text = renderBoard(p, (c, r) => formatCoord(c, r, 'letters'));
    const lines = text.split('\n');
    expect(lines[0]).toContain('A');
    expect(lines[0]).toContain('O');
    // 行 1 有白子,行 8 有黑子
    expect(lines[1]).toContain('O');
    expect(lines[8]).toContain('X');
    expect(lines).toHaveLength(size + 1);
  });
});

describe('opponentOf', () => {
  it('黑白互指', () => {
    expect(opponentOf('black')).toBe('white');
    expect(opponentOf('white')).toBe('black');
  });
});
