/**
 * dsh-pixiv-sync —— 指定画师的 pixiv 增量下载器
 *
 * 设置界面：注册到 DSH 设置的独立栏目（settings.section，见 lib/client.js）
 * 后端接口：lib/api.js 提供的同源 HTTP API
 * 下载内核：lib/engine.js
 *
 * 唯一数据源是本地 SQLite + config.json，界面和工具都读写这同一份。
 */

import {
  addArtist,
  adoptExisting,
  fetchArtistName,
  getDataDir,
  getSchedule,
  listArtists,
  loadConfig,
  localDate,
  openDb,
  readCookie,
  removeArtist,
  setArtistEnabled,
  saveConfig,
  setSchedule,
  status,
  sync,
  writeCookie,
} from './lib/engine.js'

import { parseArtistIds, registerApi } from './lib/api.js'
import { lock } from './lib/lock.js'
import {
  describeNotify,
  formatLocal,
  loadNotify,
  normalizeTarget,
  pushSyncResult,
  saveNotify,
  sendTestMessage,
} from './lib/notify.js'

export const name = 'dsh-pixiv-autodownload'

/** tools 是唯一硬依赖；webServer 是可选（没有就只少设置页） */
export const inject = ['tools']

/** 工具定义直通：不 import '@deepseek-ai/dsh-tools'（链接安装解析不到那个包） */
const defineTool = (def) => def

const fmtBytes = (b) => `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`

// ---------------------------------------------------------------- 定时

const TICK_MS = 60_000

function dueNow(schedule, now = new Date()) {
  if (!schedule.enabled) return false
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(schedule.time))
  if (!m) return false
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return false
  if (schedule.lastRunDate === localDate(now)) return false
  const target = new Date(now)
  target.setHours(h, min, 0, 0)
  return now >= target
}

async function runScheduled(log = () => {}) {
  if (lock.busy) return null
  lock.busy = true
  const dir = getDataDir()
  try {
    const result = await sync({ dir, log: () => {} })
    setSchedule(dir, {
      lastRunAt: new Date().toISOString(),
      lastRunDate: localDate(),
      lastResult: {
        works: result.works,
        files: result.files,
        failed: result.failed,
        skipped: result.skipped,
        seconds: result.seconds,
      },
    })
    // 定时跑完把摘要推到 QQ；没配置推送时 pushSyncResult 直接跳过
    await pushSyncResult(dir, { mode: 'auto', result, log })
    return result
  } catch (err) {
    await pushSyncResult(dir, { mode: 'auto', error: err, log })
    throw err
  } finally {
    lock.busy = false
  }
}

async function tick(logger) {
  if (lock.busy) return
  const schedule = getSchedule(getDataDir())
  if (!dueNow(schedule)) return
  logger?.info?.(`pixiv-sync 定时同步开始（每天 ${schedule.time}）`)
  const say = (message) => (logger?.info ? logger.info(message) : logger?.debug?.(message))
  try {
    const result = await runScheduled(say)
    if (result) {
      logger?.info?.(
        `pixiv-sync 定时同步完成：新增 ${result.works} 个作品 / ${result.files} 张，失败 ${result.failed}`
      )
    }
  } catch (err) {
    logger?.warn?.(`pixiv-sync 定时同步失败：${err.message}`)
  }
}

// ---------------------------------------------------------------- 文案

function renderArtists(rows) {
  if (rows.length === 0) return '还没有画师。到「设置 → Pixiv 自动下载」里填 ID 或主页链接。'
  return rows
    .map(
      (r) =>
        `${r.enabled ? '✓' : '✗'} ${r.id} ${r.name || '(未命名)'} — 作品 ${r.works}，文件 ${r.files}，上次同步 ${r.last_sync_at ? formatLocal(r.last_sync_at) : '从未'}`
    )
    .join('\n')
}

function renderSchedule(s) {
  const pieces = [`定时：${s.enabled ? '已启用' : '已停用'}，每天 ${s.time}（本机时区）`]
  pieces.push(`上次自动运行：${s.lastRunAt ? formatLocal(s.lastRunAt) : '从未'}`)
  if (s.lastResult) {
    const r = s.lastResult
    pieces.push(
      `${r.failed > 0 ? '❌' : '✅'}  上次结果：新增 ${r.works} 个作品 / ${r.files} 张，失败 ${r.failed}，耗时 ${r.seconds}s`
    )
  }
  return pieces.join('\n')
}

// ---------------------------------------------------------------- 工具

async function runAction(args) {
  const dir = getDataDir()
  const config = loadConfig(dir)
  const action = args.action

  if (action === 'status') {
    const s = status(dir)
    const cookie = readCookie(dir, config) ? '已配置（可看私密/R18）' : '未配置（只能看公开作品）'
    return `画师 ${s.artists.length}，作品记录 ${s.totals.works}，文件记录 ${s.totals.files}，合计 ${fmtBytes(s.totals.bytes)}
登录态：${cookie}
输出目录：${config.outputDir}
命名：${config.folderTemplate} / ${config.fileTemplate}.{ext}

${renderArtists(s.artists)}

${renderSchedule(getSchedule(dir))}

${describeNotify(loadNotify(dir))}`
  }

  if (action === 'run') {
    if (lock.busy) return '已经有一轮同步在跑，等它结束。'
    const only = parseArtistIds(args.artists)
    const lines = []
    lock.busy = true
    let result
    try {
      result = await sync({
        dir,
        only,
        limit: Number(args.limit) || 0,
        full: Boolean(args.full),
        log: (m) => lines.push(m),
      })
    } catch (err) {
      await pushSyncResult(dir, { mode: 'manual', error: err, log: (m) => lines.push(m) })
      throw err
    } finally {
      lock.busy = false
    }
    lines.push(
      `\n===== 汇总 =====\n画师 ${result.artists}，新增作品 ${result.works}，新增图片 ${result.files}，跳过 ${result.skipped}，失败 ${result.failed}，共 ${(result.bytes / 1024 / 1024).toFixed(1)} MB，耗时 ${result.seconds}s`
    )
    if (!result.cookie) lines.push('（未配置 cookie，R18 与私密作品看不到）')
    const pushed = await pushSyncResult(dir, { mode: 'manual', result })
    if (pushed?.skipped) lines.push('QQ 推送：未启用（设置页「QQ 推送」里填 AppID / AppSecret / openid）')
    else if (pushed) lines.push(pushed.ok ? `✅ QQ 推送：已发送 ${pushed.sent} 条` : `❌ QQ 推送失败：${pushed.errors.join(' | ')}`)
    return lines.join('\n')
  }

  if (action === 'list_artists') return renderArtists(listArtists(openDb(dir)))

  if (action === 'add_artist') {
    const ids = parseArtistIds(args.artists)
    if (ids.length === 0) return '需要 artists 参数：画师 ID 或主页链接。'
    const db = openDb(dir)
    const cookie = readCookie(dir, config)
    const lines = []
    for (const id of ids) {
      let artistName = args.name || ''
      if (!artistName) {
        try {
          artistName = await fetchArtistName(id, config, cookie)
        } catch {
          lines.push(`! ${id} 反查名字失败，同步时会重试`)
        }
      }
      addArtist(db, id, artistName)
      lines.push(`+ ${id}${artistName ? ' ' + artistName : ''}`)
    }
    db.close()
    return lines.join('\n')
  }

  if (action === 'remove_artist') {
    const ids = parseArtistIds(args.artists)
    if (ids.length === 0) return '需要 artists 参数。'
    const db = openDb(dir)
    for (const id of ids) removeArtist(db, id)
    db.close()
    return `已移除：${ids.join(', ')}（已下载的记录保留）`
  }

  if (action === 'enable_artist' || action === 'disable_artist') {
    const ids = parseArtistIds(args.artists)
    if (ids.length === 0) return '需要 artists 参数。'
    const db = openDb(dir)
    for (const id of ids) setArtistEnabled(db, id, action === 'enable_artist')
    db.close()
    return `${action === 'enable_artist' ? '已启用' : '已暂停'}：${ids.join(', ')}`
  }

  if (action === 'set_cookie') {
    if (!args.cookie) return '需要 cookie 参数。'
    writeCookie(dir, config, args.cookie)
    return '已保存，下次同步生效。'
  }

  if (action === 'schedule_get') return renderSchedule(getSchedule(dir))

  if (action === 'schedule_set') {
    const patch = {}
    if (args.time !== undefined) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(args.time).trim())
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '时间格式不对，要 HH:MM。'
      patch.time = `${String(m[1]).padStart(2, '0')}:${m[2]}`
    }
    if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled)
    if (Object.keys(patch).length === 0) return '需要 time 或 enabled。'
    patch.lastRunDate = null
    return renderSchedule(setSchedule(dir, patch))
  }

  if (action === 'set_naming') {
    const patch = {}
    if (args.folderTemplate !== undefined) patch.folderTemplate = String(args.folderTemplate)
    if (args.fileTemplate !== undefined) patch.fileTemplate = String(args.fileTemplate)
    if (args.outputDir !== undefined) patch.outputDir = String(args.outputDir)
    if (Object.keys(patch).length === 0) return '需要 folderTemplate、fileTemplate 或 outputDir。'
    const merged = saveConfig(dir, patch)
    return `${merged.folderTemplate} / ${merged.fileTemplate}.{ext}\n输出目录：${merged.outputDir}`
  }

  if (action === 'notify_get') return describeNotify(loadNotify(dir))

  if (action === 'notify_set') {
    const patch = {}
    if (args.pushEnabled !== undefined) patch.enabled = Boolean(args.pushEnabled)
    if (args.appId !== undefined) patch.appId = String(args.appId).trim()
    if (args.appSecret !== undefined) patch.appSecret = String(args.appSecret).trim()
    if (args.target !== undefined) patch.target = normalizeTarget(args.target)
    if (Object.keys(patch).length === 0) return '需要 pushEnabled、appId、appSecret 或 target。'
    saveNotify(dir, patch)
    return describeNotify(loadNotify(dir))
  }

  if (action === 'push_test') {
    try {
      const out = await sendTestMessage(dir)
      return `✅ 已发送测试消息（${out.sent} 条）。${describeNotify(loadNotify(dir))}`
    } catch (err) {
      return `❌ 推送测试失败：${err.message}`
    }
  }

  if (action === 'adopt') {
    const r = adoptExisting(openDb(dir), config.outputDir)
    return `扫描完成：${r.artists} 个画师目录，${r.files} 个文件已入库`
  }

  return `未知 action：${action}`
}

// ---------------------------------------------------------------- 入口

export function apply(ctx) {
  // 库是空的、但输出目录里已经有图时，先补一遍记录，避免重下
  try {
    const dir = getDataDir()
    const db = openDb(dir)
    const count = db.prepare('SELECT COUNT(*) AS n FROM artists').get().n
    db.close()
    if (count === 0) adoptExisting(openDb(dir), loadConfig(dir).outputDir)
  } catch (err) {
    ctx.logger?.warn?.(`pixiv-sync 初始化扫描失败：${err.message}`)
  }

  ctx.tools.register(
    defineTool({
      name: 'pixiv_sync',
      description:
        'Incremental Pixiv downloader for a fixed artist list. Remembers artist IDs and downloaded files in its own SQLite database, so a sync only fetches works it has never seen. It runs its own daily schedule while DSH is open. Settings (artists, cookie, schedule, naming, QQ push, manual sync) live in the plugin\'s section under DSH Settings. Every sync (scheduled or manual) can be pushed to QQ through the official QQ bot HTTP API. Actions: run, status, list_artists, add_artist, remove_artist, enable_artist, disable_artist, set_cookie, adopt, schedule_get, schedule_set, set_naming, notify_get, notify_set, push_test.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: [
            'run',
            'status',
            'list_artists',
            'add_artist',
            'remove_artist',
            'enable_artist',
            'disable_artist',
            'set_cookie',
            'adopt',
            'schedule_get',
            'schedule_set',
            'set_naming',
            'notify_get',
            'notify_set',
            'push_test',
          ],
          description: 'Which operation to perform.',
        },
        artists: {
          type: 'string',
          description:
            'Artist IDs or profile URLs, several separated by commas. Required by add_artist, remove_artist, enable_artist, disable_artist. Optional for run, to limit the sync to those artists.',
        },
        name: {
          type: 'string',
          description: 'Artist display name for add_artist; usually omit it, the name is looked up from Pixiv.',
        },
        limit: {
          type: 'integer',
          description: 'For run: stop after this many new works per artist. 0 means no limit.',
        },
        full: {
          type: 'boolean',
          description:
            'For run: also re-scan works already recorded, to backfill gaps. Slow; an ordinary run only checks works newer than the newest known one.',
        },
        cookie: {
          type: 'string',
          description: 'For set_cookie: the PHPSESSID value or a full Cookie header.',
        },
        time: { type: 'string', description: 'For schedule_set: daily run time as HH:MM in local time.' },
        enabled: { type: 'boolean', description: 'For schedule_set: turn the daily run on or off.' },
        folderTemplate: { type: 'string', description: 'For set_naming: folder template, e.g. "{user}-{uid}".' },
        fileTemplate: { type: 'string', description: 'For set_naming: filename template, e.g. "{id}_p{page}-{title}".' },
        outputDir: { type: 'string', description: 'For set_naming: absolute path of the download root folder.' },
        pushEnabled: { type: 'boolean', description: 'For notify_set: turn QQ push of sync results on or off.' },
        appId: { type: 'string', description: 'For notify_set: QQ bot AppID used to push sync results.' },
        appSecret: {
          type: 'string',
          description: 'For notify_set: QQ bot AppSecret (stored locally in notify.json, never echoed back).',
        },
        target: {
          type: 'string',
          description:
            'For notify_set: the QQ conversation to push to — your own c2c openid, or group:<group_openid>. A bare openid is treated as c2c.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: (args) => runAction(args ?? {}),
    })
  )

  // 设置页的后端接口
  try {
    const ws = ctx.get('webServer')
    if (ws !== undefined) registerApi(ws, ctx)
    else ctx.inject(['webServer'], (sub) => registerApi(sub.webServer, sub))
  } catch (err) {
    ctx.logger?.warn?.(`pixiv-sync 接口注册失败：${err.message}`)
  }

  // 内置定时器
  ctx.effect(() => {
    const t = setInterval(() => {
      tick(ctx.logger).catch(() => {})
    }, TICK_MS)
    setTimeout(() => tick(ctx.logger).catch(() => {}), 5000)
    return () => clearInterval(t)
  })
}

export default { name, inject, apply }
