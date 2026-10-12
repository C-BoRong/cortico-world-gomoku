import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

export interface GomokuConfigSection {
  enabled: boolean;
  host: string;
  port: number;
  botColor: 'black' | 'white';
  forbiddenEnabled: boolean;
  maxHistoryGames: number;
}

export const GOMOKU_DEFAULTS: GomokuConfigSection = {
  enabled: false, host: '127.0.0.1', port: 7790,
  botColor: 'white', forbiddenEnabled: true, maxHistoryGames: 100,
};

export function gomokuConfigGroup(language: Language = 'zh'): ConfigGroup {
  const zh = language === 'zh' || language === 'zh-Hant';
  return {
    id: 'world:gomoku', owner: 'world:gomoku',
    schema: {
      type: 'object', title: zh ? '五子棋' : 'Gomoku',
      properties: {
        'worlds.gomoku.host': { type: 'string', title: zh ? '监听地址' : 'Listen address',
          description: zh ? '127.0.0.1 只供本机访问；0.0.0.0 允许局域网访问。修改后重启 World。' : '127.0.0.1 for this computer; 0.0.0.0 for LAN access. Restart the World after changing.' },
        'worlds.gomoku.port': { type: 'integer', minimum: 1, maximum: 65535, title: zh ? '棋盘网页端口' : 'Board port',
          description: zh ? '修改后重启 World；端口占用时报告错误。' : 'Restart the World after changing; occupied ports are reported.' },
        'worlds.gomoku.botColor': { type: 'string', enum: ['black', 'white'], title: zh ? '新对局默认 bot 棋色' : 'Default bot color', 'x-hot': true },
        'worlds.gomoku.forbiddenEnabled': { type: 'boolean', title: zh ? '新对局默认启用禁手' : 'Enable forbidden moves by default', 'x-hot': true },
        'worlds.gomoku.maxHistoryGames': { type: 'integer', minimum: 1, maximum: 1000, title: zh ? '历史对局保留数' : 'Saved games',
          description: zh ? '开新局或清空保存旧局，超出后删除最旧记录。' : 'Starting or clearing saves the old game and removes the oldest excess records.', 'x-hot': true },
      },
    },
  };
}
