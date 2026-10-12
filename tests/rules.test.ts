import { describe, expect, it } from 'vitest';
import { analyzeMove, coordinate, createBoard, evaluateMove, formatCoordinate, opposite, parseCoordinate, type Board, type Stone } from '../src/rules.ts';

function place(board: Board, coordinates: string[], stone: Stone = 'black'): Board {
  for (const text of coordinates) {
    const point = parseCoordinate(text)!;
    board[point.row][point.col] = stone;
  }
  return board;
}
function move(board: Board, coordinate: string, stone: Stone = 'black', renju = true) {
  const { row, col } = parseCoordinate(coordinate)!;
  return evaluateMove(board, row, col, stone, renju);
}

describe('coordinates and basic board rules', () => {
  it('uses A1 at top left and accepts all 225 coordinates', () => {
    expect(parseCoordinate(' a1 ')).toEqual({ row: 0, col: 0 });
    expect(parseCoordinate('O15')).toEqual({ row: 14, col: 14 });
    for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) {
      expect(parseCoordinate(formatCoordinate(row, col))).toEqual({ row, col });
    }
    for (const value of ['P1', 'A0', 'A16', 'A01', 'H8x', '8H']) expect(parseCoordinate(value)).toBeNull();
  });
  it('rejects occupied and off-board points without changing the board', () => {
    const board = place(createBoard(), ['H8']);
    expect(move(board, 'H8').legal).toBe(false);
    expect(evaluateMove(board, 15, 7, 'white', true).legal).toBe(false);
    const before = JSON.stringify(board);
    expect(move(board, 'G8').legal).toBe(true);
    expect(JSON.stringify(board)).toBe(before);
  });
  it('wins on each of the four axes, including board edges', () => {
    for (const [existing, last] of [
      [['A1', 'B1', 'C1', 'D1'], 'E1'],
      [['O11', 'O12', 'O13', 'O14'], 'O15'],
      [['A1', 'B2', 'C3', 'D4'], 'E5'],
      [['K5', 'L4', 'M3', 'N2'], 'O1'],
    ] as const) {
      expect(move(place(createBoard(), [...existing]), last)).toMatchObject({ legal: true, win: true });
    }
  });
  it('allows white and unrestricted black to win with six', () => {
    const coordinates = ['E8', 'F8', 'G8', 'I8', 'J8'];
    expect(move(place(createBoard(), coordinates, 'white'), 'H8', 'white')).toMatchObject({ legal: true, win: true });
    expect(move(place(createBoard(), coordinates), 'H8', 'black', false)).toMatchObject({ legal: true, win: true });
  });
  it('adapts x/y coordinates and gives the complete winning line', () => {
    const board = place(createBoard(), ['A1', 'B2', 'C3', 'D4']);
    expect(coordinate(4, 4)).toBe('E5');
    expect(opposite('black')).toBe('white');
    expect(analyzeMove(board, 4, 4, 'black', true)).toMatchObject({ winning: true,
      winningLine: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }] });
    expect(analyzeMove(board, 3, 3, 'black', true)).toMatchObject({ legal: false, winning: false, winningLine: [] });
  });
});

describe('Renju forbidden moves', () => {
  it('rejects a black overline', () => {
    const board = place(createBoard(), ['E8', 'F8', 'G8', 'I8', 'J8']);
    expect(move(board, 'H8')).toMatchObject({ legal: false, win: false, forbidden: 'overline' });
  });
  it('counts a straight four once despite its two winning ends', () => {
    const board = place(createBoard(), ['F8', 'G8', 'I8']);
    expect(move(board, 'H8')).toMatchObject({ legal: true, forbidden: null, fours: 1 });
  });
  it('counts exact-five endpoints even with a cross-axis overline', () => {
    const board = place(createBoard(), ['F8', 'G8', 'I8',
      'E4', 'E5', 'E6', 'E7', 'E9', 'J4', 'J5', 'J6', 'J7', 'J9']);
    expect(move(board, 'H8')).toMatchObject({ legal: true, forbidden: null, fours: 1 });
  });
  it('rejects double-fours on different axes', () => {
    const board = place(createBoard(), ['F8', 'G8', 'I8', 'H6', 'H7', 'H9']);
    expect(move(board, 'H8')).toMatchObject({ legal: false, forbidden: 'double-four', fours: 2 });
  });
  it('recognizes two distinct broken fours on the same axis', () => {
    const board = place(createBoard(), ['E8', 'G8', 'I8', 'K8']);
    expect(move(board, 'H8')).toMatchObject({ legal: false, forbidden: 'double-four', fours: 2 });
  });
  it('rejects two genuine open threes', () => {
    const board = place(createBoard(), ['G8', 'I8', 'H7', 'H9']);
    expect(move(board, 'H8')).toMatchObject({ legal: false, forbidden: 'double-three', threes: 2 });
  });
  it('recognizes a broken open three', () => {
    const board = place(createBoard(), ['F8', 'I8', 'H7', 'H9']);
    expect(move(board, 'H8')).toMatchObject({ legal: false, forbidden: 'double-three', threes: 2 });
  });
  it('does not count a three blocked by the edge or by white', () => {
    expect(move(place(createBoard(), ['A8', 'B8']), 'C8')).toMatchObject({ legal: true, threes: 0 });
    const board = place(createBoard(), ['G8', 'I8', 'H7', 'H9']);
    place(board, ['E8', 'K8'], 'white');
    expect(move(board, 'H8')).toMatchObject({ legal: true, threes: 1 });
  });
  it('does not count a three whose only open-four extensions are overlines', () => {
    const board = place(createBoard(), ['G8', 'I8', 'H7', 'H9',
      'F4', 'F5', 'F6', 'F7', 'F9', 'J4', 'J5', 'J6', 'J7', 'J9']);
    expect(move(board, 'H8')).toMatchObject({ legal: true, threes: 1 });
  });
  it('recursively excludes a three whose extension is a double-three', () => {
    const board = place(createBoard(), ['G8', 'I8', 'H7', 'H9',
      'F4', 'F5', 'F6', 'F7', 'F9', 'J7', 'J9', 'I7', 'K9']);
    expect(move(board, 'H8')).toMatchObject({ legal: true, threes: 1 });
  });
  it('awards an exact five even when another axis makes an overline', () => {
    const board = place(createBoard(), ['D8', 'E8', 'F8', 'G8', 'H5', 'H6', 'H7', 'H9', 'H10']);
    expect(move(board, 'H8')).toMatchObject({ legal: true, win: true, forbidden: null });
  });
  it('gives an exact five priority over simultaneous double-four', () => {
    const board = place(createBoard(), ['D8', 'E8', 'F8', 'G8', 'H6', 'H7', 'H9', 'F6', 'G7', 'I9']);
    expect(move(board, 'H8')).toMatchObject({ legal: true, win: true, forbidden: null });
  });
  it('gives an exact five priority over simultaneous double-three', () => {
    const board = place(createBoard(), ['D8', 'E8', 'F8', 'G8', 'H7', 'H9', 'G7', 'I9']);
    expect(move(board, 'H8')).toMatchObject({ legal: true, win: true, forbidden: null });
  });
  it('does not apply double-three or double-four restrictions to white', () => {
    const board = place(createBoard(), ['G8', 'I8', 'H7', 'H9'], 'white');
    expect(move(board, 'H8', 'white')).toMatchObject({ legal: true, forbidden: null });
  });
});
