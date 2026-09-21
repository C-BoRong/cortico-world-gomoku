import type { ConfigGroup } from 'cortico/core/types.ts';
import type { CoordStyle } from './coord.ts';

/**
 * config.json 的 `worlds.gomoku` 段。默认禁用,由 bot 的 declares 或部署配置启用。
 *
 * 全部键都在构造时读走:端口要绑定、棋盘尺寸进棋盘几何。改了要重启 World 生效,
 * 所以配置组里除 `enabled` 外都不标 `x-hot`。
 */
export interface GomokuConfigSection {
  enabled: boolean;
  /** 棋盘网页监听端口。 */
  port: number;
  /** 监听地址;默认只本机。改成非回环地址前先读 README 的安全一节。 */
  host: string;
  /** 棋盘路数。 */
  boardSize: number;
  /** 连几子算赢。 */
  winLength: number;
  /** 坐标的念法,见 coord.ts。 */
  coordStyle: CoordStyle;
  /** 挂载时是否用系统默认浏览器打开棋盘页。 */
  autoOpen: boolean;
}

export const GOMOKU_DEFAULTS: GomokuConfigSection = {
  enabled: false,
  port: 8600,
  host: '127.0.0.1',
  boardSize: 15,
  winLength: 5,
  coordStyle: 'letters',
  autoOpen: false,
};

/** 这一 World 声明的可调项;控制台照它渲染旋钮,照路径写回 config.json。 */
export const GOMOKU_CONFIG_GROUP: ConfigGroup = {
  id: 'world:gomoku',
  owner: 'world:gomoku',
  schema: {
    type: 'object',
    title: 'Gomoku',
    description: '棋盘网页与对局规则。除启用开关外都在 World 启动时读走,改完重启生效。',
    properties: {
      'worlds.gomoku.port': {
        type: 'integer',
        title: '棋盘网页端口',
        minimum: 1024,
        maximum: 65535,
        'x-hot': false,
        description: '棋盘页监听的端口。默认 8600;被占用时 World 启动失败并在日志里报原因。',
      },
      'worlds.gomoku.host': {
        type: 'string',
        title: '监听地址',
        'x-hot': false,
        description: '127.0.0.1 只本机;改成 0.0.0.0 其他机器也能连,且棋盘页不做认证。',
      },
      'worlds.gomoku.boardSize': {
        type: 'integer',
        title: '棋盘路数',
        minimum: 5,
        maximum: 25,
        'x-hot': false,
        description: '标准五子棋是 15 路。',
      },
      'worlds.gomoku.winLength': {
        type: 'integer',
        title: '连几子算赢',
        minimum: 3,
        maximum: 10,
        'x-hot': false,
        description: '标准是 5,须不大于棋盘路数。',
      },
      'worlds.gomoku.coordStyle': {
        type: 'string',
        title: '坐标记法',
        enum: ['letters', 'numeric'],
        'x-hot': false,
        description: 'letters 是 A1–O15,numeric 是 1,1–15,15。按模型哪种读得准来选。',
      },
      'worlds.gomoku.autoOpen': {
        type: 'boolean',
        title: '挂载时打开棋盘页',
        'x-hot': false,
        description: '用系统默认浏览器打开棋盘页。',
      },
    },
  },
};

/** `configOptions('gomoku.coordStyle', language)` 的本地化标签。 */
export const GOMOKU_COORD_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  zh: [
    { value: 'letters', label: '字母列(H8)' },
    { value: 'numeric', label: '数字列(8,8)' },
  ],
  en: [
    { value: 'letters', label: 'Letters (H8)' },
    { value: 'numeric', label: 'Numbers (8,8)' },
  ],
};

/** 配置合法性;World 构造前由 preflight 调用。返回错误信息,合法时返回 null。 */
export function validateGomokuConfig(cfg: GomokuConfigSection): string | null {
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    return `棋盘网页端口 ${String(cfg.port)} 不是 1–65535 之间的整数。`;
  }
  if (!Number.isInteger(cfg.boardSize) || cfg.boardSize < 3 || cfg.boardSize > 25) {
    return `棋盘路数 ${String(cfg.boardSize)} 不是 3–25 之间的整数。`;
  }
  if (!Number.isInteger(cfg.winLength) || cfg.winLength < 3 || cfg.winLength > cfg.boardSize) {
    return `连子数 ${String(cfg.winLength)} 须在 3 到棋盘路数 ${cfg.boardSize} 之间。`;
  }
  if (cfg.coordStyle !== 'letters' && cfg.coordStyle !== 'numeric') {
    return `坐标记法 ${String(cfg.coordStyle)} 不在 letters / numeric 之中。`;
  }
  return null;
}
