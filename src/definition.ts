import type { WorldDefinition } from 'cortico/world.ts';
import { GOMOKU_DEFAULTS, type GomokuConfigSection } from './config.ts';
import { GomokuWorld } from './world.ts';

export const GOMOKU: WorldDefinition<GomokuConfigSection> = {
  id: 'gomoku', label: '五子棋 · Gomoku',
  defaults: () => ({ ...GOMOKU_DEFAULTS }),
  create: (ctx) => new GomokuWorld(ctx),
};
