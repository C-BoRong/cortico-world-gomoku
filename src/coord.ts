/**
 * 坐标的念法。棋盘内部一律 0 基 (col,row);这一层只管怎么把它写成给模型与人看的串,
 * 以及怎么把模型给的串读回来。
 *
 * 两种风格由 `worlds.gomoku.coordStyle` 选:
 * - `letters`:列 A…O,行 1…15 —— 国际通用的五子棋/围棋记法,如 `H8`(默认)
 * - `numeric`:列 1…15,行 1…15 —— 如 `8,8` 或 `8 8`
 *
 * 做成可调是因为不同模型对这两种形式的可靠性不一样;哪个更稳是部署者比我们清楚的事。
 */

export type CoordStyle = 'letters' | 'numeric';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface Coord {
  readonly col: number;
  readonly row: number;
}

/** 0 基坐标 → 给模型与人看的串。 */
export function formatCoord(col: number, row: number, style: CoordStyle): string {
  if (style === 'letters') return `${LETTERS[col] ?? '?'}${row + 1}`;
  return `${col + 1},${row + 1}`;
}

/**
 * 解析模型或人给的坐标。接受常见的几种写法,失败返回 null 而不是抛错 ——
 * 调用方要把失败变成一条能读的回执,而不是一次工具异常。
 *
 * 接受的写法:`H8` / `h8` / `H-8` / `8,8` / `8 8` / `8-8` / `(8,8)`;
 * 无论当前风格是哪种,两种风格都尝试解析,这样模型偶尔记错风格也不至于卡住。
 */
export function parseCoord(input: string, size: number): Coord | null {
  const text = String(input).trim().toUpperCase().replace(/[()\[\]]/g, '');
  if (!text) return null;

  // 字母 + 数字:H8
  const alpha = /^([A-Z])\s*[-\s,]?\s*(\d{1,2})$/.exec(text);
  if (alpha) {
    const col = LETTERS.indexOf(alpha[1] as string);
    const row = Number(alpha[2]) - 1;
    if (col >= 0 && col < size && row >= 0 && row < size) return { col, row };
    return null;
  }

  // 纯数字对:8,8 / 8 8 / 8-8
  const numeric = /^(\d{1,2})\s*[-\s,]\s*(\d{1,2})$/.exec(text);
  if (numeric) {
    const col = Number(numeric[1]) - 1;
    const row = Number(numeric[2]) - 1;
    if (col >= 0 && col < size && row >= 0 && row < size) return { col, row };
    return null;
  }

  return null;
}

/** 这一风格在提示词里怎么描述,由 envPromptVars 报给模板。 */
export function explainCoord(style: CoordStyle, size: number): string {
  const lastCol = formatCoord(size - 1, 0, style).replace(/\d+.*/, '');
  if (style === 'letters') {
    return `列用字母 A…${lastCol}(从左到右),行用数字 1…${size}(从上到下),合起来写成一格,例如 H8。`;
  }
  return `列与行都用数字 1…${size},按「列,行」写成 \`8,8\`(左上角是 1,1)。`;
}
