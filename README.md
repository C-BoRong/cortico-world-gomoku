# cortico-world-gomoku

Owner: `src/definition.ts`

一个 World 扩展:让 bot 与人下一局网页五子棋。包自带棋盘页,人在浏览器里点格子落子,bot 通过工具落子。
棋盘状态由 World 保管,进程重启后当前这一局不再存在。

要求 cortico 契约 **v4**(框架 0.1.1 之后)。

## 安装

在 Cortico 仓库根下:

```bash
cd extensions && corepack pnpm add --ignore-workspace cortico-world-gomoku
```

`--ignore-workspace` 不能省。装完重启进程。也可以在控制台「扩展」页的「手动安装」里填
`cortico-world-gomoku`,或填本机包目录的绝对路径以 link 方式装入。装好后到**控制台「World 总览」
页**激活 Gomoku(`worlds.gomoku.enabled` 默认是 false;bot 的 `declares` 声明了它则自动启用)。

## 装进实例后该看见什么

- 扩展页卡片「已加载」;World 总览多一张 Gomoku 卡。
- 终端时间线里出现一条 `gomoku.started`,正文里带着棋盘页的地址。
- Gomoku 页多一行配置组,以及一颗「打开棋盘」的链接,点开就是棋盘页。
- 让 bot 开一局(`gomoku_start`),你在棋盘页点一下,时间线里出现 `gomoku.opponent_placed`,bot 随后落子。

## 文件

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`:id、label、默认配置段、`preflight`、`configOptions`、`create()` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组、合法性校验 |
| `src/game.ts` | 规则本身:落子、四方向判胜、平局、渲染棋盘文本。不碰事件与网络 |
| `src/coord.ts` | 坐标的两种念法与解析,以及给提示词的说明文本 |
| `src/server.ts` | 棋盘页的 HTTP 服务:`GET /`、`GET /state`、`POST /place`、`POST /resign` |
| `src/board.html` | 棋盘页本体,内联样式与脚本,无构建步骤、无外部依赖 |
| `src/world.ts` | `World` 实现:事件、四个工具、`console()` 声明、环境提示词取值 |
| `src/ENV_PROMPT.md` | 环境提示词模板,占位符由 `envPromptVars()` 报值 |
| `tests/` | 规则、坐标、事件、工具、HTTP 端点;`helpers/fake-host.ts` 是记录推送的假宿主 |

## 配置

`worlds.gomoku` 段,全部键在 World 启动时读走,改完重启生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | World 声明的启用开关恒为 false,由 bot 的 `declares` 或部署配置打开 |
| `port` | `8600` | 棋盘页端口。被占用时 World 启动失败,日志与操作者看到的原因里带端口 |
| `host` | `127.0.0.1` | 监听地址。改成非回环地址前先读下面「安全」一节 |
| `boardSize` | `15` | 棋盘路数 |
| `winLength` | `5` | 连几子获胜,须不大于棋盘路数 |
| `coordStyle` | `letters` | 坐标记法:`letters` 是 `H8`,`numeric` 是 `8,8` |
| `autoOpen` | `false` | 挂载时是否用系统默认浏览器打开棋盘页 |

`coordStyle` 可调是因为不同模型对这两种写法的可靠性不一样;哪种更稳是部署者比包作者清楚的事。

## 工具与事件

| 工具 | 作用 |
|---|---|
| `gomoku_start` | 开一局并选 bot 执黑还是执白。已有一局进行中时拒绝,不丢弃那一局 |
| `gomoku_place` | 落一子,坐标按 `coordStyle`。不是自己回合、格子被占、局面已结束时给失败回执 |
| `gomoku_resign` | 认输,判对手胜 |
| `gomoku_status` | 读局面快照(棋盘 + 轮次 + 状态) |

| 事件 | origin | 何时 |
|---|---|---|
| `gomoku.started` | internal | 开局、以及 World 挂载时 |
| `gomoku.opponent_placed` | external | 人在棋盘页落子,正文带当时的棋盘 |
| `gomoku.ended` | internal | 五连、认输或平局 |

人的落子用 `flush` 投递:五子棋是回合制,这条事件要立刻唤醒 bot。不用 `preempt`,因为人的落子不该
打断 bot 已经开始的思考。

## HTTP 端点

棋盘页只用三样东西。用轮询而不是 WebSocket:局面只有几百个格子、人机对局是秒级节奏,轮询够用,
换来的是不用维护握手、重连与广播。

| 端点 | 作用 |
|---|---|
| `GET /` | 棋盘页 |
| `GET /state` | 当前局面;还没有对局时 `{"none":true}` |
| `POST /place` | 人落子,body `{col,row}`(0 基)。被拒时回 409 与原因 |
| `POST /resign` | 人认输 |

## 安全

棋盘页**不做认证**,默认只监听 `127.0.0.1`,与控制台的默认一致。把 `host` 改成 `0.0.0.0` 或某个
非回环地址后,任何能连到这个端口的人都能替你落子;这时 World 会在启动日志里记一条 warn。
要暴露给别的机器,把它放在你信得过的网络里,或自己在前面加一层控制。

这个包不需要任何密钥。

## 改名的清单

包名、`id: 'gomoku'`、`GOMOKU` / `Gomoku` / `gomoku_` 前缀、事件 `type` 的 `gomoku.` 段、
配置键 `worlds.gomoku.*`、promptDoc key、`cortico-world-gomoku` 的目录名。
规矩见 [docs/worlds.md](../../cortico/docs/worlds.md) 与 [docs/extensions.md](../../cortico/docs/extensions.md)。
