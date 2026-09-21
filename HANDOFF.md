# cortico-world-gomoku

一个 World 扩展包:让 bot 跟人下一局网页五子棋。Cortico 的 World 是 bot 与一个外部环境之间的
唯一边界,这里的外部环境就是一局五子棋。

## 状态

- 第一级(构建)过了:`pnpm typecheck` 与 `pnpm test` 绿,58 个测试。
- 第二级(装载)过了:`pnpm check:extension` 通过,含干装载。
- 第三级(行为目击)待开发者做,见下面「装进实例」。

## 这个包做什么

包同时提供两半:

- **棋盘网页**:一个极小的 HTTP 服务,页面是自包含的一张 HTML(内联样式与脚本,无构建步骤、
  无外部依赖)。人在浏览器里点格子落子。
- **World 边界**:四个工具给 bot 用,三条事件报给人机交互。

## 开发者要的四件事,分别落在哪

| 要求 | 落在哪 |
|---|---|
| AI 看到棋子落点 | 人落子后投 `gomoku.opponent_placed`,正文里带整张棋盘;bot 随时可调 `gomoku_status` |
| AI 可以开始游戏 | `gomoku_start` |
| 选择白子黑子 | `gomoku_start` 的 `stone` 参数 |
| 认输 | `gomoku_resign`(bot 认输)、棋盘页的「认输」按钮(人认输) |
| 配置界面改端口 | `worlds.gomoku.port`,控制台按配置组渲染 |
| 快速打开棋盘网页 | Gomoku 页的「打开棋盘」链接;`autoOpen` 打开时自动用系统浏览器打开 |

另外补的:棋盘页有轮次与状态显示、最后一手标记、认输按钮、胜负提示;坐标记法可配。

## 装进他的实例

1. 控制台「扩展」页 →「手动安装」→ 填包目录的绝对路径,
   即 `C:\Users\brong\Desktop\Cortina\state\packages\cortico-world-gomoku`。
2. 重启进程。
3. 在部署的 `config.json` 里给 `worlds.gomoku` 打开 `enabled`(或让 bot 的 `declares` 声明它),
   端口默认 8600。
4. 该看见:扩展页卡片「已加载」、World 总览多一张 Gomoku、终端时间线出现 `gomoku.started`
   且正文带棋盘页地址;Gomoku 页有配置组与「打开棋盘」链接。
5. 让 bot 开一局,你在棋盘页落子,时间线里应出现 `gomoku.opponent_placed`。

## 设计决定与理由

逐条记在 `state/design/gomoku.md`(工作区里),要点:

- 轮询而不是 WebSocket:局面小、节奏是秒级,轮询够用且不用维护连接。
- 用 `console.links` 而不是控制台面板:要的是一个能拖到第二个显示器的独立页面。
- 人的落子用 `flush` 投递,不用 `preempt`:不打断 bot 已开始的思考。
- `gomoku_start` 在已有进行中局面时拒绝,不静默丢弃那一局。
- 棋盘不做认证,默认只监听 127.0.0.1;改成非回环时启动日志记 warn。

## 验证到哪一级

前两级我自己跑完了(上面的状态)。第三级只有你能看:装进实例后终端时间线里有没有
`gomoku.started`,以及棋盘页点下去 bot 有没有回应。
