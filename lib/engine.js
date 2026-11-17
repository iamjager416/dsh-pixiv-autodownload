/**
 * pixiv 增量同步内核
 *
 * 只做三件事：
 *   1. 记住指定画师的 ID（artists 表）
 *   2. 记住已经下过哪些作品的哪些页（works / files 表）
 *   3. 同步时只补没下过的
 *
 * 零依赖：只用内置 fetch 和 node:sqlite（Node 22.13+）。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const DEFAULT_CONFIG = {
  /** 图片保存根目录，每个画师一个子文件夹：<画师名>-<画师ID> */
  outputDir: path.join(os.homedir(), 'Pictures', 'pixiv'),
  /** 登录 cookie 文件名（放在数据目录里）。可为空，未登录只能看公开作品 */
  cookieFile: 'cookie.txt',
  /** API 请求间隔（毫秒） */
  delayMs: 900,
  /** 图片之间的间隔（毫秒） */
  imageDelayMs: 150,
  /** 失败重试次数 */
  retries: 3,
  /** 画师目录模板，可用占位符：{user} {uid} */
  folderTemplate: '{user}-{uid}',
  /** 文件名模板（不含扩展名），可用占位符：{id} {page} {title} {user} {uid} {date} {type} */
  fileTemplate: '{id}_p{page}-{title}',
}

/** 插件数据目录：$DSH_HOME/pixiv-sync */
export function getDataDir(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dir = path.join(home, 'pixiv-sync')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function loadConfig(dir) {
  const file = path.join(dir, 'config.json')
  let user = {}
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      user = {}
    }
  } else {
    fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8')
  }
  return { ...DEFAULT_CONFIG, ...user }
}

export function saveConfig(dir, patch) {
  const merged = { ...loadConfig(dir), ...patch }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

export function readCookie(dir, config) {
  const p = path.join(dir, config.cookieFile || 'cookie.txt')
  if (!fs.existsSync(p)) return ''
  const raw = fs.readFileSync(p, 'utf8').trim()
  if (!raw) return ''
  return /=/.test(raw) ? raw : `PHPSESSID=${raw}`
}

export function writeCookie(dir, config, cookie) {
  const p = path.join(dir, config.cookieFile || 'cookie.txt')
  fs.writeFileSync(p, String(cookie).trim() + '\n', 'utf8')
  return p
}

// ---------------------------------------------------------------- 数据库

export function openDb(dir) {
  const db = new DatabaseSync(path.join(dir, 'pixiv-sync.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS artists (
      id           INTEGER PRIMARY KEY,
      name         TEXT    NOT NULL DEFAULT '',
      enabled      INTEGER NOT NULL DEFAULT 1,
      added_at     TEXT    NOT NULL,
      last_sync_at TEXT,
      last_result  TEXT
    );

    CREATE TABLE IF NOT EXISTS works (
      id            INTEGER PRIMARY KEY,
      artist_id     INTEGER NOT NULL,
      illust_type   INTEGER,
      title         TEXT,
      upload_date   TEXT,
      page_count    INTEGER,
      first_seen_at TEXT    NOT NULL,
      skipped       INTEGER NOT NULL DEFAULT 0,
      skip_reason   TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      work_id       INTEGER NOT NULL,
      page          INTEGER NOT NULL,
      path          TEXT    NOT NULL,
      bytes         INTEGER,
      downloaded_at TEXT    NOT NULL,
      PRIMARY KEY (work_id, page)
    );

    CREATE INDEX IF NOT EXISTS idx_works_artist ON works(artist_id);
    CREATE INDEX IF NOT EXISTS idx_files_work    ON files(work_id);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `)
  return db
}

// ---------------------------------------------------------------- 键值元数据

function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return fallback
  }
}

function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value))
}

/** 内置定时的设置：{ enabled, time: 'HH:MM', lastRunAt, lastRunDate, lastResult } */
export const DEFAULT_SCHEDULE = {
  enabled: true,
  time: '09:00',
  lastRunAt: null,
  lastRunDate: null,
  lastResult: null,
}

export function getSchedule(dir) {
  const db = openDb(dir)
  const saved = getMeta(db, 'schedule', null)
  db.close()
  return { ...DEFAULT_SCHEDULE, ...(saved || {}) }
}

export function setSchedule(dir, patch) {
  const next = { ...getSchedule(dir), ...patch }
  const db = openDb(dir)
  setMeta(db, 'schedule', next)
  db.close()
  return next
}

/** 本地日期字符串 YYYY-MM-DD，用来判断「今天跑没跑过」 */
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const nowISO = () => new Date().toISOString()

// ---------------------------------------------------------------- HTTP

let lastRequestAt = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pace(ms) {
  const wait = lastRequestAt + ms - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} ${url}`)
    this.status = status
  }
}

async function requestJson(url, config, cookie) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.pixiv.net/' }
  if (cookie) headers.Cookie = cookie

  let lastErr
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(30000, 2000 * 2 ** (attempt - 1)))
    await pace(config.delayMs)
    try {
      const res = await fetch(url, { headers })
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15000)
        throw new HttpError(429, url)
      }
      if (!res.ok) throw new HttpError(res.status, url)
      const json = await res.json()
      if (json?.error) throw new Error(`pixiv 返回错误：${json.message || 'unknown'}`)
      return json.body
    } catch (err) {
      lastErr = err
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------- pixiv

export async function fetchArtistWorkIds(uid, config, cookie) {
  const body = await requestJson(`https://www.pixiv.net/ajax/user/${uid}/profile/all?lang=zh`, config, cookie)
  const ids = [...Object.keys(body?.illusts ?? {}), ...Object.keys(body?.manga ?? {})]
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  return [...new Set(ids)].sort((a, b) => a - b)
}

const fetchIllustDetail = (id, config, cookie) =>
  requestJson(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, config, cookie)

/** 用最新作品的详情反查画师名，用于建目录 */
export async function fetchArtistName(uid, config, cookie) {
  const ids = await fetchArtistWorkIds(uid, config, cookie)
  if (ids.length === 0) return ''
  const detail = await fetchIllustDetail(ids[ids.length - 1], config, cookie)
  return detail?.userName ?? ''
}

// ---------------------------------------------------------------- 文件命名

function sanitize(name, maxLen = 60) {
  let s = String(name ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!s) s = '无题'
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s
}

const extFromUrl = (url) => (/\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1] ?? 'jpg').toLowerCase()

/** 展开 {占位符}；未知占位符原样保留，方便发现拼错 */
function expandTemplate(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : whole
  )
}

const TYPE_NAMES = { 0: 'illust', 1: 'manga', 2: 'ugoira', 3: 'novel' }

/**
 * 按 config 里的模板算出这张图该存哪。
 * 模板里的非法字符会被替换；标题为空时用「无题」。
 */
function targetPath(config, artist, work, page, url) {
  const ext = extFromUrl(url)
  const vars = {
    user: artist.name || `artist${artist.id}`,
    uid: artist.id,
    id: work.id,
    page,
    title: work.title || '无题',
    date: String(work.uploadDate ?? '').slice(0, 10),
    type: TYPE_NAMES[work.illustType] ?? 'illust',
    ext,
  }
  const folder = expandTemplate(config.folderTemplate || '{user}-{uid}', vars)
    .split(/[\\/]+/)
    .map((s) => sanitize(s))
    .filter(Boolean)
    .join(path.sep)
  const file = sanitize(expandTemplate(config.fileTemplate || '{id}_p{page}-{title}', vars), 120)
  return path.join(config.outputDir, folder, `${file}.${ext}`)
}

function knownPages(db, workId) {
  return new Set(db.prepare('SELECT page FROM files WHERE work_id = ?').all(workId).map((r) => r.page))
}

function recordFile(db, workId, page, filePath, bytes) {
  db.prepare(
    `INSERT INTO files (work_id, page, path, bytes, downloaded_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(work_id, page) DO UPDATE SET path = excluded.path, bytes = excluded.bytes`
  ).run(workId, page, filePath, bytes, nowISO())
}

async function downloadFile(url, dest, config, cookie) {
  let lastErr
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (attempt > 0) {
      await sleep(3000 * attempt)
    }
    await pace(config.imageDelayMs)
    try {
      const headers = { 'User-Agent': UA, Referer: 'https://www.pixiv.net/' }
      if (cookie) headers.Cookie = cookie
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) throw new Error('空文件')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)
      return buf.length
    } catch (err) {
      lastErr = err
      if (/HTTP (403|404)/.test(err.message)) throw err
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------- 画师管理

export function listArtists(db) {
  return db
    .prepare(
      `SELECT a.*,
        (SELECT COUNT(*) FROM works w WHERE w.artist_id = a.id) AS works,
        (SELECT COUNT(*) FROM files f JOIN works w ON w.id = f.work_id WHERE w.artist_id = a.id) AS files
       FROM artists a ORDER BY a.id`
    )
    .all()
}

export function addArtist(db, id, name = '') {
  db.prepare(
    `INSERT INTO artists (id, name, enabled, added_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = 1,
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE artists.name END`
  ).run(id, name, nowISO())
}

export function setArtistEnabled(db, id, enabled) {
  db.prepare('UPDATE artists SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function removeArtist(db, id) {
  db.prepare('DELETE FROM artists WHERE id = ?').run(id)
}

/** 扫描输出目录，把硬盘上已有的图片补进数据库，避免重下一遍 */
export function adoptExisting(db, outputDir) {
  if (!fs.existsSync(outputDir)) return { artists: 0, files: 0 }
  let artistCount = 0
  let fileCount = 0

  for (const dir of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const m = /^(.*)-(\d+)$/.exec(dir.name)
    if (!m) continue
    const name = m[1]
    const uid = Number(m[2])

    db.prepare(
      `INSERT INTO artists (id, name, enabled, added_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET name = CASE WHEN artists.name = '' THEN excluded.name ELSE artists.name END`
    ).run(uid, name, nowISO())
    artistCount++

    for (const f of fs.readdirSync(path.join(outputDir, dir.name), { withFileTypes: true })) {
      if (!f.isFile()) continue
      const full = path.join(outputDir, dir.name, f.name)
      const size = fs.statSync(full).size

      const multi = /^(\d+)_p(\d+)/.exec(f.name)
      if (multi) {
        const workId = Number(multi[1])
        db.prepare(
          `INSERT INTO works (id, artist_id, first_seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`
        ).run(workId, uid, nowISO())
        recordFile(db, workId, Number(multi[2]), full, size)
        fileCount++
        continue
      }

      // 动图转换产物：<作品ID>-<标题>.webp 之类，没有 _p 页码
      const ugoira = /^(\d+)-.*\.(webp|webm|gif|apng|mp4)$/i.exec(f.name)
      if (ugoira) {
        const workId = Number(ugoira[1])
        db.prepare(
          `INSERT INTO works (id, artist_id, first_seen_at, skipped, skip_reason)
           VALUES (?, ?, ?, 1, '动图已转换过')
           ON CONFLICT(id) DO UPDATE SET skipped = 1, skip_reason = '动图已转换过'`
        ).run(workId, uid, nowISO())
        recordFile(db, workId, 0, full, size)
        fileCount++
      }
    }
  }
  return { artists: artistCount, files: fileCount }
}

// ---------------------------------------------------------------- 同步

async function syncOneArtist(db, artist, config, cookie, opts, log) {
  // 名单是通过设置页或链接加进来的时候没有名字，这里补一次反查，目录名才好看
  if (!artist.name) {
    try {
      const name = await fetchArtistName(artist.id, config, cookie)
      if (name) {
        db.prepare('UPDATE artists SET name = ? WHERE id = ?').run(name, artist.id)
        artist.name = name
      }
    } catch {
      // 拿不到名字不影响下载，目录名会是 artist<ID>
    }
  }

  const stats = {
    artist: artist.name || String(artist.id),
    id: artist.id,
    total: 0,
    candidates: 0,
    newWorks: 0,
    files: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
  }

  let ids
  try {
    ids = await fetchArtistWorkIds(artist.id, config, cookie)
  } catch (err) {
    log(`  ✗ ${stats.artist} 拉取作品列表失败：${err.message}`)
    db.prepare('UPDATE artists SET last_sync_at = ?, last_result = ? WHERE id = ?').run(
      nowISO(),
      JSON.stringify(stats),
      artist.id
    )
    stats.failed++
    return stats
  }

  // 作品 ID 单调递增：新增 = ID 大于库里最大的那个。默认只处理这些，一次同步仅 1 次 API 请求
  const maxKnownId = db
    .prepare('SELECT COALESCE(MAX(id), 0) AS m FROM works WHERE artist_id = ?')
    .get(artist.id).m
  const candidates = opts.full ? ids : ids.filter((id) => id > maxKnownId)
  stats.total = ids.length
  stats.candidates = candidates.length

  const workRow = db.prepare('SELECT * FROM works WHERE id = ?')
  const onDisk = (p) => {
    try {
      return fs.statSync(p).size > 0
    } catch {
      return false
    }
  }

  for (const id of candidates) {
    if (opts.limit && stats.newWorks >= opts.limit) break

    const known = workRow.get(id)
    if (known && known.skipped) {
      stats.skipped++
      continue
    }
    if (opts.full && known && known.page_count != null && knownPages(db, id).size >= known.page_count) {
      stats.skipped++
      continue
    }

    let detail
    try {
      detail = await fetchIllustDetail(id, config, cookie)
    } catch (err) {
      db.prepare(
        `INSERT INTO works (id, artist_id, first_seen_at, skipped, skip_reason) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET skip_reason = excluded.skip_reason`
      ).run(id, artist.id, nowISO(), err.message)
      stats.failed++
      continue
    }

    // 动图需要 ffmpeg 转码，这里明确跳过
    if (detail.illustType === 2) {
      db.prepare(
        `INSERT INTO works (id, artist_id, illust_type, title, upload_date, page_count, first_seen_at, skipped, skip_reason)
         VALUES (?, ?, 2, ?, ?, 0, ?, 1, 'ugoira 动图，未下载')
         ON CONFLICT(id) DO UPDATE SET skipped = 1, skip_reason = 'ugoira 动图，未下载'`
      ).run(id, artist.id, detail.title ?? '', detail.uploadDate ?? '', nowISO())
      stats.skipped++
      continue
    }

    const pageCount = detail.pageCount ?? 1
    db.prepare(
      `INSERT INTO works (id, artist_id, illust_type, title, upload_date, page_count, first_seen_at, skipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET illust_type = excluded.illust_type, title = excluded.title,
         upload_date = excluded.upload_date, page_count = excluded.page_count, skipped = 0, skip_reason = NULL`
    ).run(id, artist.id, detail.illustType ?? 0, detail.title ?? '', detail.uploadDate ?? '', pageCount, nowISO())

    const have = knownPages(db, id)
    let fresh = true
    let pageFailed = false

    for (let page = 0; page < pageCount; page++) {
      if (have.has(page)) {
        fresh = false
        continue
      }
      const url = String(detail.urls.original).replace('_p0.', `_p${page}.`)
      const dest = targetPath(config, artist, { id, title: detail.title, uploadDate: detail.uploadDate, illustType: detail.illustType }, page, url)

      if (onDisk(dest)) {
        recordFile(db, id, page, dest, fs.statSync(dest).size)
        fresh = false
        continue
      }

      try {
        const bytes = await downloadFile(url, dest, config, cookie)
        recordFile(db, id, page, dest, bytes)
        stats.files++
        stats.bytes += bytes
        log(`  ↓ ${path.basename(dest)} (${(bytes / 1024).toFixed(0)} KB)`)
      } catch (err) {
        log(`  ! 下载失败 ${id}_p${page}：${err.message}`)
        stats.failed++
        pageFailed = true
      }
    }
    if (fresh && !pageFailed) stats.newWorks++
  }

  db.prepare('UPDATE artists SET last_sync_at = ?, last_result = ? WHERE id = ?').run(
    nowISO(),
    JSON.stringify(stats),
    artist.id
  )
  log(
    `  ${stats.artist}(${artist.id})：pixiv 上共 ${stats.total} 个，本次检查 ${stats.candidates} 个 → 新增 ${stats.newWorks} 个作品 / ${stats.files} 张，跳过 ${stats.skipped}，失败 ${stats.failed}`
  )
  return stats
}

/** 同步所有（或指定的）启用画师 */
export async function sync({ dir, only, limit = 0, full = false, log = () => {} }) {
  const config = loadConfig(dir)
  const cookie = readCookie(dir, config)
  const db = openDb(dir)

  let artists = db.prepare('SELECT * FROM artists WHERE enabled = 1 ORDER BY id').all()
  if (only && only.length) {
    const set = new Set(only)
    artists = artists.filter((a) => set.has(a.id))
  }

  const started = Date.now()
  const results = []
  for (const artist of artists) {
    log(`▶ 同步 ${artist.name || artist.id} (${artist.id})`)
    results.push(await syncOneArtist(db, artist, config, cookie, { limit, full }, log))
  }
  db.close()

  const sum = results.reduce(
    (a, s) => ({
      artists: a.artists + 1,
      works: a.works + s.newWorks,
      files: a.files + s.files,
      failed: a.failed + s.failed,
      bytes: a.bytes + s.bytes,
      skipped: a.skipped + s.skipped,
    }),
    { artists: 0, works: 0, files: 0, failed: 0, bytes: 0, skipped: 0 }
  )
  return { ...sum, seconds: Math.round((Date.now() - started) / 1000), cookie: Boolean(cookie), details: results }
}

/** 汇总统计 */
export function status(dir) {
  const db = openDb(dir)
  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM works) AS works,
              (SELECT COUNT(*) FROM files) AS files,
              (SELECT COALESCE(SUM(bytes),0) FROM files) AS bytes`
    )
    .get()
  const artists = listArtists(db)
  db.close()
  return { totals, artists }
}
