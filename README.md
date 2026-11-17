# dsh-pixiv-autodownload

按你指定的画师自动下载 Pixiv 新作品，下过的自动跳过。DeepSeek Harness（DSH）插件。

Incremental Pixiv downloader for a fixed artist list. A DeepSeek Harness plugin.

## 它做什么

- 记住你指定的画师 ID 和已经下载过的文件，同步时只补新作品
- 每日定时自动同步（DSH 运行期间）
- 设置页里管理画师：气泡展示，支持直接粘画师主页链接
- 目录与文件名规则可自定义
- 可选的 cookie，填了就能下 R18 和私密作品

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

## 注意

- 不配 cookie 只能看到公开作品
- 动图（ugoira）会跳过，不下载
- 它不知道你在硬盘上删了什么，删过的文件不会重下
- 定时只在 DSH 运行期间触发

## 数据

存在 `$DSH_HOME/pixiv-sync/`：SQLite 库、`config.json`、可选的 `cookie.txt`。都不外发。

## 许可

MIT
