/**
 * 五子棋的规则本身:落子、判胜、判满。不碰事件、不碰网络,只做棋盘计算。
 * 坐标对外一律 0 基 (col,row);给模型看的记法由 coord.ts 负责。
 */

export type Stone = 'black' | 'white';
export type Cell = Stone | null;

/** 一局的进行状态。`playing` 之外都是终局,终局后不再接受落子。 */
export type GamePhase = 'playing' | 'black-won' | 'white-won' | 'draw' | 'resigned';

/** 谁在终局中胜出;平局与无人胜出时为 null。 */
export function winnerOf(phase: GamePhase): Stone | null {
  if (phase === 'black-won') return 'black';
  if (phase === 'white-won') return 'white';
  return null;
}

export function opponentOf(stone: Stone): Stone {
  return stone === 'black' ? 'white' : 'black';
}

/** 局面快照;落子返回新对象,不改旧的。 */
export interface Position {
  readonly size: number;
  readonly winLength: number;
  readonly cells: readonly Cell[];
  readonly phase: GamePhase;
  /** 轮谁下;终局时为 null。 */
  readonly turn: Stone | null;
  /** 最后一手的 0 基坐标,供页面标出;还没人下过时为 null。 */
  readonly lastMove: { readonly col: number; readonly row: number } | null;
  /** 已落子数。 */
  readonly moves: number;
}

export function createPosition(size: number, winLength: number, first: Stone): Position {
  return {
    size,
    winLength,
    cells: new Array<Cell>(size * size).fill(null),
    phase: 'playing',
    turn: first,
    lastMove: null,
    moves: 0,
  };
}

export function cellAt(p: Position, col: number, row: number): Cell {
  return p.cells[row * p.size + col] ?? null;
}

export function inBounds(p: Position, col: number, row: number): boolean {
  return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0 && col < p.size && row < p.size;
}

/** 落子被拒的原因;`null` 表示可以落。这些是机械规则,不是判断。 */
export type RejectReason = 'out-of-bounds' | 'occupied' | 'game-over';

export function rejectReason(p: Position, col: number, row: number): RejectReason | null {
  if (!inBounds(p, col, row)) return 'out-of-bounds';
  if (p.phase !== 'playing') return 'game-over';
  if (cellAt(p, col, row) !== null) return 'occupied';
  return null;
}

/**
 * 在 (col,row) 落下当前轮次的一方,返回新局面。调用前须用 rejectReason 校验;
 * 非法落子在此抛错,而不是返回一个静默不变的局面。
 */
export function place(p: Position, col: number, row: number): Position {
  const reason = rejectReason(p, col, row);
  if (reason) throw new Error(`illegal move at ${col},${row}: ${reason}`);
  const stone = p.turn as Stone;
  const cells = p.cells.slice();
  cells[row * p.size + col] = stone;
  const next: Position = {
    ...p,
    cells,
    lastMove: { col, row },
    moves: p.moves + 1,
  };
  if (hasLine(next, col, row, stone)) {
    return { ...next, phase: stone === 'black' ? 'black-won' : 'white-won', turn: null };
  }
  if (next.moves === p.size * p.size) {
    return { ...next, phase: 'draw', turn: null };
  }
  return { ...next, turn: opponentOf(stone) };
}

/** 认输:当前轮次的一方输,对手胜。 */
export function resign(p: Position): Position {
  if (p.phase !== 'playing') throw new Error(`cannot resign from ${p.phase}`);
  const loser = p.turn as Stone;
  const winner = opponentOf(loser);
  return { ...p, phase: winner === 'black' ? 'black-won' : 'white-won', turn: null };
}

/** 刚落下的这一子在四个方向上是否连成 winLength。 */
export function hasLine(p: Position, col: number, row: number, stone: Stone): boolean {
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ] as const;
  for (const [dc, dr] of dirs) {
    let run = 1;
    for (const sign of [1, -1]) {
      let c = col + dc * sign;
      let r = row + dr * sign;
      while (inBounds(p, c, r) && cellAt(p, c, r) === stone) {
        run += 1;
        c += dc * sign;
        r += dr * sign;
      }
    }
    if (run >= p.winLength) return true;
  }
  return false;
}

/** 五连的坐标,供回执指出赢在哪;没赢时为 null。 */
export function winningLine(p: Position): ReadonlyArray<{ col: number; row: number }> | null {
  const last = p.lastMove;
  if (!last) return null;
  const stone = cellAt(p, last.col, last.row);
  if (!stone) return null;
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ] as const;
  for (const [dc, dr] of dirs) {
    const line: Array<{ col: number; row: number }> = [{ col: last.col, row: last.row }];
    for (const sign of [1, -1]) {
      let c = last.col + dc * sign;
      let r = last.row + dr * sign;
      while (inBounds(p, c, r) && cellAt(p, c, r) === stone) {
        line.push({ col: c, row: r });
        c += dc * sign;
        r += dr * sign;
      }
    }
    if (line.length >= p.winLength) {
      return line.sort((a, b) => a.row - b.row || a.col - b.col);
    }
  }
  return null;
}

/**
 * 棋盘的可读文本:一行一个行号,列用 A–O 之类的列标。给模型看的正文用它,
 * 一行一行比 225 个坐标点清楚。
 */
export function renderBoard(p: Position, label: (col: number, row: number) => string): string {
  const cols = Array.from({ length: p.size }, (_, c) => label(c, 0).replace(/\d+$/, ''));
  const header = `   ${cols.join(' ')}`;
  const rows: string[] = [header];
  for (let r = 0; r < p.size; r += 1) {
    const cells: string[] = [];
    for (let c = 0; c < p.size; c += 1) {
      const v = cellAt(p, c, r);
      cells.push(v === 'black' ? 'X' : v === 'white' ? 'O' : '.');
    }
    rows.push(`${String(r + 1).padStart(2, ' ')} ${cells.join(' ')}`);
  }
  return rows.join('\n');
}
