# dsh-pixiv-autodownload

按你指定的画师自动下载 Pixiv 新作品，下过的自动跳过。DeepSeek Harness（DSH）插件。

Incremental Pixiv downloader for a fixed artist list. A DeepSeek Harness plugin.

## 它做什么

- 记住你指定的画师 ID 和已经下载过的文件，同步时只补新作品
- 每日定时自动同步（DSH 运行期间）
- 设置页里管理画师：气泡展示，支持直接粘画师主页链接
- 目录与文件名规则可自定义
- 可选的 cookie，填了就能下 R18 和私密作品
- 每轮同步（定时或手动）结束可以把摘要推到 QQ

## 安装

```sh
dsh plugin --profile <profile> add github:iamjager416/dsh-pixiv-autodownload
```

或者用 Release 里的预构建包：

```sh
dsh plugin --profile <profile> add https://github.com/iamjager416/dsh-pixiv-autodownload/releases/latest/download/dsh-pixiv-autodownload.tgz
```

安装后在 **设置 → Pixiv 自动下载** 里配置。

## 用法

1. 输入框填画师 ID 或 `https://www.pixiv.net/users/<ID>` 链接，回车加入
2. 需要每天自动跑就设时间并勾选「启用每日同步」
3. 想立刻跑一次，用「立即同步」，可选「只下新的」或「补齐历史」

## 命名规则

默认目录 `<画师名>-<画师ID>`，文件名 `<作品ID>_p<页>-<标题>.<扩展名>`。

可用占位符：`{id}` `{page}` `{title}` `{user}` `{uid}` `{date}` `{type}`。

## QQ 推送

设置页的「QQ 推送」里填三样东西，然后把「启用 QQ 推送」勾上：

- **机器人 AppID / AppSecret**：QQ 开放平台后台的机器人凭据
- **你的对话 openid**：你和这个机器人私聊的会话 id（只填 id，不用带 `c2c:`）

之后每轮同步——包括每日定时、设置页的「立即同步」、`pixiv_sync` 工具的 `run`，以及命令行 `node cli.js sync`——结束时都会发一条摘要，内容是新增作品数 / 图片数 / 跳过 / 失败 / 体积 / 耗时，以及本轮有动作的画师。没有新作品也会发一条，方便确认定时器还活着。同步失败时改发一条失败消息。

推送走 QQ 官方机器人 HTTP API（`bots.qq.com/app/getAppAccessToken` → `api.bot.qq.com/v2/users/{openid}/messages`），和 `dsh-checkin` 同一套，受 QQ 主动消息频控限制。推送失败只记状态、不影响下载：设置页会显示「上次推送」的时间和失败原因，`pixiv_sync` 的 `status` / `notify_get` 也能看到。

凭据单独放在 `$DSH_HOME/pixiv-sync/notify.json`，不进 `config.json`，也不出现在工具的返回里（`status` 只显示 AppSecret「已保存」）。

## 注意

- 不配 cookie 只能看到公开作品
- 动图（ugoira）会跳过，不下载
- 它不知道你在硬盘上删了什么，删过的文件不会重下
- 定时只在 DSH 运行期间触发

## 数据

存在 `$DSH_HOME/pixiv-sync/`：SQLite 库、`config.json`、可选的 `cookie.txt`，以及填了推送后的 `notify.json`。下载和同步都在本机，只有开了 QQ 推送才会把同步摘要发出去。

## 许可

MIT
