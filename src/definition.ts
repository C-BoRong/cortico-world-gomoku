import type { Language } from 'cortico/core/language.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import {
  GOMOKU_COORD_OPTIONS,
  GOMOKU_DEFAULTS,
  validateGomokuConfig,
  type GomokuConfigSection,
} from './config.ts';
import { GomokuWorld } from './world.ts';

export const GOMOKU: WorldDefinition<GomokuConfigSection> = {
  id: 'gomoku',
  label: 'Gomoku',
  defaults: () => ({ ...GOMOKU_DEFAULTS }),

  /** 配置读不通就不激活,让操作者在控制台看到原因,而不是等监听端口时才炸。 */
  preflight: (ctx) => {
    const problem = validateGomokuConfig(ctx.cfg);
    if (problem) throw new Error(problem);
  },

  /** 坐标记法的两个选项;未知 kind 返回空数组,框架继续问别的 World。 */
  configOptions: (kind: string, language: Language) =>
    kind === 'gomoku.coordStyle' ? (GOMOKU_COORD_OPTIONS[language] ?? GOMOKU_COORD_OPTIONS.zh!) : [],

  create: (ctx) => new GomokuWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
};
