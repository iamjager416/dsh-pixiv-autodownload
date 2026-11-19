/**
 * 设置页用的同源 HTTP API。
 * 前端（lib/client.js）只用这些接口读写，宿主不碰 DOM。
 */

import { spawn } from 'node:child_process'

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
  saveConfig,
  setArtistEnabled,
  setSchedule,
  status,
  sync,
  writeCookie,
} from './engine.js'

import { lock } from './lock.js'
import { formatLocal, loadNotify, normalizeTarget, pushSyncResult, saveNotify, sendTestMessage } from './notify.js'

/**
 * 弹系统的文件夹选择框。
 * 用 Windows PowerShell（默认 STA）跑 Forms.FolderBrowserDialog，
 * 初始目录通过环境变量传，避免脚本里的引号转义问题。
 */
function pickDirectory(initial) {
  return new Promise((resolve, reject) => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择 pixiv 图片保存目录'
if ($env:PS_PICK_INITIAL -and (Test-Path -LiteralPath $env:PS_PICK_INITIAL)) { $dlg.SelectedPath = $env:PS_PICK_INITIAL }
$dlg.ShowNewFolderButton = $true
$result = $dlg.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }
`.trim()

    let out = ''
    let err = ''
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        windowsHide: true,
        env: { ...process.env, PS_PICK_INITIAL: initial || '' },
      })
    } catch (e) {
      return reject(e)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error('选择窗口超时（120 秒）'))
    }, 120000)

    child.stdout.on('data', (c) => (out += c.toString()))
    child.stderr.on('data', (c) => (err += c.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const picked = out.trim()
      if (picked) return resolve(picked)
      if (err.trim()) return reject(new Error(err.trim().split('\n')[0]))
      resolve('') // 用户取消了
    })
  })
}

export const API_BASE = '/api/pixiv-sync'

/** 从 "12345678" 或 "https://www.pixiv.net/users/12345678" 里取 ID */
export function parseArtistIds(text) {
  const ids = []
  for (const piece of String(text ?? '').split(/[\s,，、;；]+/)) {
    if (!piece) continue
    const urlMatch = /pixiv\.net\/(?:en\/)?users\/(\d+)/i.exec(piece)
    const bare = /^\d{3,12}$/.test(piece) ? piece : null
    const id = Number(urlMatch?.[1] ?? bare)
    if (Number.isInteger(id) && id > 0) ids.push(id)
  }
  return [...new Set(ids)]
}

function isLoopback(req) {
  const host = String(req.headers?.host ?? '')
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 200000) req.destroy()
    })
    req.on('end', () => resolve(data))
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 设置页点「立即同步」时用的运行状态，前端靠轮询 state 看进度 */
const runner = {
  running: false,
  mode: 'new',
  startedAt: '',
  finishedAt: '',
  message: '',
  lastResult: null,
}

/** 当前状态：名单、定时、命名、登录态、QQ 推送 */
function readState() {
  const dir = getDataDir()
  const config = loadConfig(dir)
  const s = status(dir)
  const schedule = getSchedule(dir)
  const notify = loadNotify(dir)
  return {
    artists: s.artists.map((a) => ({
      id: a.id,
      name: a.name || '',
      enabled: Boolean(a.enabled),
      works: a.works,
      files: a.files,
      lastSync: a.last_sync_at || '',
    })),
    totals: s.totals,
    schedule: {
      time: schedule.time,
      enabled: Boolean(schedule.enabled),
      lastRunAt: schedule.lastRunAt || '',
      lastResult: schedule.lastResult || null,
    },
    config: {
      folderTemplate: config.folderTemplate,
      fileTemplate: config.fileTemplate,
      outputDir: config.outputDir,
    },
    hasCookie: Boolean(readCookie(dir, config)),
    notify: {
      enabled: Boolean(notify.enabled),
      appId: notify.appId || '',
      target: notify.target || '',
      hasSecret: Boolean(notify.appSecret),
      lastPushAt: notify.lastPushAt || '',
      lastPushOk: notify.lastPushOk,
      lastPushError: notify.lastPushError || '',
    },
    sync: { ...runner },
  }
}

/** 后台跑一轮同步，立刻返回，前端轮询 state */
function startSync({ full = false, limit = 0 } = {}) {
  if (runner.running || lock.busy) return { ok: false, message: '已经有一轮同步在跑，等它结束' }

  const dir = getDataDir()
  // 先算个预估：要检查多少作品、其中多少个必须发详情请求（这是耗时主体）
  let artistsTotal = 0
  let plannedWorks = 0
  let plannedRequests = 0
  let delayMs = 900
  try {
    const db = openDb(dir)
    artistsTotal = db.prepare('SELECT COUNT(*) AS c FROM artists WHERE enabled = 1').get().c
    plannedWorks = db.prepare('SELECT COUNT(*) AS c FROM works').get().c
    plannedRequests = db
      .prepare(
        `SELECT COUNT(*) AS c FROM works w
         WHERE w.skipped = 0
           AND (w.page_count IS NULL
                OR (SELECT COUNT(*) FROM files f WHERE f.work_id = w.id) < w.page_count)`
      )
      .get().c
    db.close()
    delayMs = loadConfig(dir).delayMs
  } catch {
    // 预估失败不影响真正跑
  }

  runner.running = true
  runner.mode = full ? 'full' : 'new'
  runner.startedAt = new Date().toISOString()
  runner.finishedAt = ''
  runner.message = ''
  runner.lastResult = null
  runner.progress = {
    artistsTotal,
    artistsDone: 0,
    artistName: '',
    worksChecked: 0,
    worksTotalKnown: 0,
    requests: 0,
    files: 0,
    bytes: 0,
    startedAt: Date.now(),
    plannedWorks,
    plannedRequests,
    delayMs,
  }
  lock.busy = true

  sync({
    dir,
    full: Boolean(full),
    limit: Number(limit) || 0,
    log: () => {},
    onProgress: (p) => {
      // 引擎只报运行时计数，预估字段（plannedRequests / delayMs）要保住，别被覆盖
      runner.progress = { ...p, plannedWorks, plannedRequests, delayMs }
    },
  })
    .then(async (r) => {
      runner.lastResult = {
        artists: r.artists,
        works: r.works,
        files: r.files,
        failed: r.failed,
        skipped: r.skipped,
        bytes: r.bytes,
        seconds: r.seconds,
      }
      // 手动同步也推一份，和定时同一套推送
      const push = await pushSyncResult(dir, { mode: 'manual', result: r })
      const suffix = push?.skipped
        ? ''
        : push?.ok
          ? ` · ✅ QQ 已推送（${formatLocal(push.at)}）`
          : ' · ❌ QQ 推送失败'
      runner.message = `${r.failed > 0 ? '❌' : '✅'} 完成：新增 ${r.works} 个作品 / ${r.files} 张，跳过 ${r.skipped}，失败 ${r.failed}，耗时 ${r.seconds}s${suffix}`
    })
    .catch(async (err) => {
      await pushSyncResult(dir, { mode: 'manual', error: err })
      runner.message = `❌ 失败：${err.message}`
    })
    .finally(() => {
      runner.running = false
      lock.busy = false
      runner.finishedAt = new Date().toISOString()
    })

  return { ok: true, message: full ? '已开始补齐历史' : '已开始增量同步' }
}

async function handlePost(req) {
  const dir = getDataDir()
  const config = loadConfig(dir)
  const raw = await readBody(req)
  let body = {}
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    return { ok: false, message: '请求体不是合法 JSON' }
  }
  const action = String(body.action ?? '')

  if (action === 'add') {
    const ids = parseArtistIds(body.artists)
    if (ids.length === 0) return { ok: false, message: '没识别到画师 ID：要数字 ID 或 pixiv.net/users/<ID> 链接' }
    const cookie = readCookie(dir, config)
    const db = openDb(dir)
    const added = []
    const failed = []
    for (const id of ids) {
      let name = ''
      try {
        name = await fetchArtistName(id, config, cookie)
      } catch {
        failed.push(id)
      }
      addArtist(db, id, name)
      added.push(name ? `${name} (${id})` : String(id))
    }
    db.close()
    const tail = failed.length ? `（${failed.join('、')} 名字反查失败，已按 ID 加入）` : ''
    return { ok: true, message: `已添加：${added.join('、')}${tail}`, state: readState() }
  }

  if (action === 'remove') {
    const id = Number(body.id)
    if (!id) return { ok: false, message: '缺少 id' }
    removeArtist(openDb(dir), id)
    return { ok: true, message: `已移除 ${id}（下载记录保留）`, state: readState() }
  }

  if (action === 'toggle') {
    const id = Number(body.id)
    if (!id) return { ok: false, message: '缺少 id' }
    const db = openDb(dir)
    const row = db.prepare('SELECT enabled FROM artists WHERE id = ?').get(id)
    setArtistEnabled(db, id, !row?.enabled)
    db.close()
    return { ok: true, message: row?.enabled ? `已停用 ${id}` : `已启用 ${id}`, state: readState() }
  }

  if (action === 'schedule') {
    const time = String(body.time ?? '').trim()
    if (!/^\d{1,2}:\d{2}$/.test(time)) return { ok: false, message: '时间格式要 HH:MM' }
    const patch = { time: time.padStart(5, '0'), enabled: Boolean(body.enabled) }
    if (patch.enabled) patch.lastRunDate = null
    setSchedule(dir, patch)
    return { ok: true, message: `定时 ${patch.time}，${patch.enabled ? '已启用' : '已停用'}`, state: readState() }
  }

  if (action === 'naming') {
    saveConfig(dir, {
      folderTemplate: String(body.folderTemplate ?? '').trim() || '{user}-{uid}',
      fileTemplate: String(body.fileTemplate ?? '').trim() || '{id}_p{page}-{title}',
      outputDir: String(body.outputDir ?? '').trim() || loadConfig(dir).outputDir,
    })
    return { ok: true, message: '命名规则已保存', state: readState() }
  }

  if (action === 'notify') {
    const secret = String(body.appSecret ?? '').trim()
    const patch = {
      enabled: Boolean(body.enabled),
      appId: String(body.appId ?? '').trim(),
      target: normalizeTarget(body.target),
    }
    // AppSecret 留空表示「不改」，避免页面回填明文
    if (secret) patch.appSecret = secret
    saveNotify(dir, patch)
    return { ok: true, message: 'QQ 推送设置已保存', state: readState() }
  }

  if (action === 'notify_test') {
    try {
      const out = await sendTestMessage(dir)
      return { ok: true, message: `测试消息已发送（${out.sent} 条），去 QQ 看看`, state: readState() }
    } catch (err) {
      return { ok: false, message: `测试失败：${err.message}` }
    }
  }

  if (action === 'run') {
    const out = startSync({ full: Boolean(body.full), limit: Number(body.limit) || 0 })
    return { ...out, state: readState() }
  }

  if (action === 'pickdir') {
    try {
      const picked = await pickDirectory(config.outputDir)
      if (!picked) return { ok: true, message: '没有选择目录', state: readState() }
      saveConfig(dir, { outputDir: picked })
      return { ok: true, message: `输出目录：${picked}`, state: readState() }
    } catch (err) {
      return { ok: false, message: `选择目录失败：${err.message}` }
    }
  }

  if (action === 'cookie') {
    const cookie = String(body.cookie ?? '').trim()
    if (!cookie) return { ok: false, message: 'cookie 是空的，没有改动' }
    writeCookie(dir, loadConfig(dir), cookie)
    return { ok: true, message: 'cookie 已保存', state: readState() }
  }

  if (action === 'adopt') {
    const r = adoptExisting(openDb(dir), config.outputDir)
    return {
      ok: true,
      message: `扫描完成：${r.artists} 个画师目录，${r.files} 个文件已入库`,
      state: readState(),
    }
  }

  return { ok: false, message: `未知操作：${action}` }
}

/** DSH 的同步接口：每次切换设置页都会拉一次 */
export function registerApi(host, ctx) {
  const register = (def) => ctx.effect(() => host.register(def))

  register({
    kind: 'exact',
    path: `${API_BASE}/state`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, message: 'forbidden' })
      try {
        return sendJson(res, 200, { ok: true, state: readState() })
      } catch (err) {
        return sendJson(res, 500, { ok: false, message: String(err?.message ?? err) })
      }
    },
  })

  register({
    kind: 'exact',
    path: `${API_BASE}/action`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, message: 'forbidden' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'method not allowed' })
      try {
        const out = await handlePost(req)
        return sendJson(res, out.ok ? 200 : 400, out)
      } catch (err) {
        return sendJson(res, 500, { ok: false, message: String(err?.message ?? err) })
      }
    },
  })
}

/** 同步（给设置页的"立即同步"用） */
export async function runNow(ctx) {
  return sync({ dir: getDataDir(), log: () => {} })
}

export { localDate }
