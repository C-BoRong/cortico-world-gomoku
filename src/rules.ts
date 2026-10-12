/** Pure 15×15 board rules. Row zero is the top; column zero is A. */
export const BOARD_SIZE = 15;
export type Stone = 'black' | 'white';
export type Color = Stone;
export type Cell = Stone | null;
export type Board = Cell[][];
export interface Coordinate { row: number; col: number }
export type ForbiddenMove = 'overline' | 'double-four' | 'double-three';
export interface MoveEvaluation {
  legal: boolean;
  win: boolean;
  forbidden: ForbiddenMove | null;
  fours: number;
  threes: number;
  reason?: string;
}
export interface MoveAnalysis extends MoveEvaluation {
  winning: boolean;
  winningLine: Array<{ x: number; y: number }>;
}

const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;
interface Four { stones: number[]; winningPoints: Set<number> }
interface AnalysisContext { memo: Map<string, MoveEvaluation> }

export function createBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () => Array<Cell>(BOARD_SIZE).fill(null));
}

export function parseCoordinate(value: string): Coordinate | null {
  const match = /^([A-O])(1[0-5]|[1-9])$/i.exec(value.trim());
  if (!match) return null;
  return { row: Number(match[2]) - 1, col: match[1].toUpperCase().charCodeAt(0) - 65 };
}

export function formatCoordinate(row: number, col: number): string {
  if (!inside(row, col)) throw new RangeError('Coordinate must be on the 15×15 board.');
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

/** x/y adapter used by the game store and browser protocol. */
export function coordinate(x: number, y: number): string { return formatCoordinate(y, x); }
export function opposite(color: Color): Color { return color === 'black' ? 'white' : 'black'; }
export function analyzeMove(board: Board, x: number, y: number, color: Color, forbiddenEnabled: boolean): MoveAnalysis {
  const result = evaluateMove(board, y, x, color, forbiddenEnabled);
  const winningLine: Array<{ x: number; y: number }> = [];
  if (result.win) {
    const draft = board.map(line => [...line]);
    draft[y][x] = color;
    for (const [dy, dx] of DIRECTIONS) {
      let startX = x;
      let startY = y;
      while (inside(startY - dy, startX - dx) && draft[startY - dy][startX - dx] === color) {
        startY -= dy; startX -= dx;
      }
      const line: Array<{ x: number; y: number }> = [];
      while (inside(startY, startX) && draft[startY][startX] === color) {
        line.push({ x: startX, y: startY }); startY += dy; startX += dx;
      }
      if (line.length >= 5 && (color !== 'black' || !forbiddenEnabled || line.length === 5)) {
        winningLine.push(...line); break;
      }
    }
  }
  return { ...result, winning: result.win, winningLine };
}

/** Inspect a proposed move without changing the supplied board. */
export function evaluateMove(
  board: Board, row: number, col: number, stone: Stone, renju: boolean,
): MoveEvaluation {
  if (!inside(row, col)) return rejected('Coordinate must be A1 through O15.');
  if (board.length !== BOARD_SIZE || board.some(line => line.length !== BOARD_SIZE)) {
    return rejected('Board must contain 15 rows and 15 columns.');
  }
  if (board[row][col] !== null) return rejected('This intersection already has a stone.');
  const draft = board.map(line => [...line]);
  draft[row][col] = stone;
  if (stone === 'white' || !renju) {
    return { legal: true, win: lineLengths(draft, row, col, stone).some(length => length >= 5),
      forbidden: null, fours: 0, threes: 0 };
  }
  return analyzeBlack(draft, row, col, { memo: new Map() });
}

function inside(row: number, col: number): boolean {
  return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0
    && row < BOARD_SIZE && col < BOARD_SIZE;
}
function cellId(row: number, col: number): number { return row * BOARD_SIZE + col; }
function rejected(reason: string): MoveEvaluation {
  return { legal: false, win: false, forbidden: null, fours: 0, threes: 0, reason };
}
function lineLength(board: Board, row: number, col: number, stone: Stone, dr: number, dc: number): number {
  let length = 1;
  for (const sign of [-1, 1]) {
    let r = row + sign * dr;
    let c = col + sign * dc;
    while (inside(r, c) && board[r][c] === stone) {
      length++; r += sign * dr; c += sign * dc;
    }
  }
  return length;
}
function lineLengths(board: Board, row: number, col: number, stone: Stone): number[] {
  return DIRECTIONS.map(([dr, dc]) => lineLength(board, row, col, stone, dr, dc));
}

/**
 * A four is identified by its four existing stones, not by its winning ends.
 * Thus .XXXX. is one four, while two distinct broken fours on one axis are two.
 */
function findFours(board: Board, row: number, col: number, dr: number, dc: number): Four[] {
  const anchor = cellId(row, col);
  const groups = new Map<string, Four>();
  for (let start = -4; start <= 0; start++) {
    const stones: number[] = [];
    let empty: Coordinate | null = null;
    let usable = true;
    for (let offset = start; offset < start + 5; offset++) {
      const r = row + offset * dr;
      const c = col + offset * dc;
      if (!inside(r, c) || board[r][c] === 'white') { usable = false; break; }
      if (board[r][c] === 'black') stones.push(cellId(r, c));
      else if (empty) { usable = false; break; }
      else empty = { row: r, col: c };
    }
    if (!usable || stones.length !== 4 || !empty || !stones.includes(anchor)) continue;
    // An exact five is a winning endpoint, including a simultaneous pattern on another axis.
    board[empty.row][empty.col] = 'black';
    const wins = lineLength(board, empty.row, empty.col, 'black', dr, dc) === 5;
    board[empty.row][empty.col] = null;
    if (!wins) continue;
    const key = stones.slice().sort((a, b) => a - b).join(',');
    let four = groups.get(key);
    if (!four) { four = { stones, winningPoints: new Set() }; groups.set(key, four); }
    four.winningPoints.add(cellId(empty.row, empty.col));
  }
  return [...groups.values()];
}

/**
 * A real three can become a straight, two-ended four through a legal black
 * move that does not also make five. Legality is checked recursively: apparent
 * threes whose only extensions are themselves forbidden do not count. Every
 * recursion adds a stone, so the finite board bounds the search.
 */
function findThrees(board: Board, row: number, col: number, context: AnalysisContext): number {
  const threes = new Set<string>();
  for (let axis = 0; axis < DIRECTIONS.length; axis++) {
    const [dr, dc] = DIRECTIONS[axis];
    for (let offset = -3; offset <= 3; offset++) {
      if (offset === 0) continue;
      const r = row + offset * dr;
      const c = col + offset * dc;
      if (!inside(r, c) || board[r][c] !== null) continue;
      board[r][c] = 'black';
      const extension = cellId(r, c);
      const openFours = findFours(board, row, col, dr, dc)
        .filter(four => four.winningPoints.size === 2 && four.stones.includes(extension));
      if (openFours.length) {
        const result = analyzeBlack(board, r, c, context);
        if (result.legal && !result.win) {
          for (const four of openFours) {
            const stones = four.stones.filter(id => id !== extension).sort((a, b) => a - b);
            threes.add(`${axis}:${stones.join(',')}`);
          }
        }
      }
      board[r][c] = null;
    }
  }
  return threes.size;
}

function analyzeBlack(board: Board, row: number, col: number, context: AnalysisContext): MoveEvaluation {
  const key = `${row},${col}:` + board.map(line => line.map(cell => cell === 'black' ? 'b' : cell === 'white' ? 'w' : '.').join('')).join('');
  const cached = context.memo.get(key);
  if (cached) return cached;
  const lengths = lineLengths(board, row, col, 'black');
  let result: MoveEvaluation;
  // Renju awards an exact five before evaluating simultaneous forbidden patterns.
  if (lengths.includes(5)) {
    result = { legal: true, win: true, forbidden: null, fours: 0, threes: 0 };
  } else if (lengths.some(length => length > 5)) {
    result = { legal: false, win: false, forbidden: 'overline', fours: 0, threes: 0,
      reason: 'Black overline: six or more stones in a row.' };
  } else {
    const fours = DIRECTIONS.reduce((count, [dr, dc]) => count + findFours(board, row, col, dr, dc).length, 0);
    if (fours >= 2) {
      result = { legal: false, win: false, forbidden: 'double-four', fours, threes: 0,
        reason: 'Black double-four: this move creates two or more fours.' };
    } else {
      const threes = findThrees(board, row, col, context);
      result = threes >= 2
        ? { legal: false, win: false, forbidden: 'double-three', fours, threes,
          reason: 'Black double-three: this move creates two or more real open threes.' }
        : { legal: true, win: false, forbidden: null, fours, threes };
    }
  }
  context.memo.set(key, result);
  return result;
}
