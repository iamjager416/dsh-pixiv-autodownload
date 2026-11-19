/**
 * 同步结果 → QQ 推送。
 *
 * 凭据单独存 $DSH_HOME/pixiv-sync/notify.json，不进 config.json，也不进会话历史：
 *   { enabled, appId, appSecret, target, lastPushAt, lastPushOk, lastPushError }
 *
 * target 只认 c2c:<openid>（私聊）和 group:<group_openid>（群）；
 * 设置页让用户填自己的 openid，这里自动补 c2c: 前缀。
 *
 * 推送永远是「尽力而为」：失败只写日志和 lastPush*，不影响下载结果。
 */

import fs from 'node:fs'
import path from 'node:path'

import { sendQqText } from './qqPush.js'

export const DEFAULT_NOTIFY = {
  enabled: false,
  appId: '',
  appSecret: '',
  target: '',
  lastPushAt: '',
  lastPushOk: null,
  lastPushError: '',
}

/** 手动 / 定时 / 命令行调用，推送标题里区分一下来源 */
const MODE_LABELS = { auto: '定时', manual: '手动', cli: '命令行' }

const notifyPath = (dir) => path.join(dir, 'notify.json')

export function loadNotify(dir) {
  const file = notifyPath(dir)
  let saved = {}
  if (fs.existsSync(file)) {
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      saved = {}
    }
  }
  return { ...DEFAULT_NOTIFY, ...saved }
}

export function saveNotify(dir, patch) {
  const merged = { ...loadNotify(dir), ...patch }
  fs.writeFileSync(notifyPath(dir), JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

/** 设置页/工具里填的 openid 统一成推送 target；已经带前缀的原样保留 */
export function normalizeTarget(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const matched = /^(c2c|group)\s*:\s*(.+)$/i.exec(text)
  if (matched) return `${matched[1].toLowerCase()}:${matched[2].trim()}`
  return `c2c:${text}`
}

/** 三样都齐了才发；少一样就当没开推送 */
export function notifyReady(notify) {
  return Boolean(notify.enabled && notify.appId && notify.appSecret && notify.target)
}

/** ISO → 本机「YYYY-MM-DD HH:MM:SS」（和签到插件一致） */
export function formatLocal(iso) {
  const date = iso ? new Date(iso) : new Date()
  if (Number.isNaN(date.getTime())) return String(iso ?? '')
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function mb(bytes) {
  return (Number(bytes || 0) / 1024 / 1024).toFixed(1)
}

/** 一轮同步的推送正文：先总账，再列出本轮有动作的画师 */
export function buildSyncText({ mode, result, at }) {
  const label = MODE_LABELS[mode] ?? '手动'
  const ok = Number(result.failed || 0) === 0
  const lines = [
    `【Pixiv 同步 ${formatLocal(at)} · ${label}】完成`,
    `${ok ? '✅' : '❌'} 新增 ${result.works} 个作品 / ${result.files} 张，跳过 ${result.skipped}，失败 ${result.failed}`,
    `⚙️ 共 ${mb(result.bytes)} MB，耗时 ${result.seconds}s，画师 ${result.artists} 位`,
  ]

  const touched = (result.details ?? []).filter((d) => d.newWorks > 0 || d.files > 0 || d.failed > 0)
  if (touched.length > 0) {
    lines.push('')
    for (const item of touched.slice(0, 8)) {
      const parts = [`新增 ${item.newWorks} 个作品 / ${item.files} 张`]
      if (item.failed > 0) parts.push(`失败 ${item.failed}`)
      lines.push(`${item.failed > 0 ? '❌' : '✅'} ${item.artist}(${item.id})：${parts.join('，')}`)
    }
    if (touched.length > 8) lines.push(`…还有 ${touched.length - 8} 位画师`)
  }

  if (!result.cookie) lines.push('⚠️ 未配置 cookie，R18 与私密作品看不到')
  return lines.join('\n')
}

export function buildFailureText({ mode, error, at }) {
  const label = MODE_LABELS[mode] ?? '手动'
  return `【Pixiv 同步 ${formatLocal(at)} · ${label}】失败\n❌ ${String(error?.message ?? error)}`
}

/**
 * 跑完一轮后推送。没配置或没启用时返回 { skipped: true }，调用方不用判断。
 * @returns {Promise<{skipped?:boolean, ok?:boolean, sent?:number, errors?:string[], at?:string}>}
 */
export async function pushSyncResult(dir, { mode = 'manual', result, error, at, log = () => {} } = {}) {
  const notify = loadNotify(dir)
  if (!notifyReady(notify)) return { skipped: true }

  const when = at || new Date().toISOString()
  const text = error ? buildFailureText({ mode, error, at: when }) : buildSyncText({ mode, result, at: when })

  try {
    const out = await sendQqText({ ...notify, text })
    saveNotify(dir, {
      lastPushAt: when,
      lastPushOk: out.ok,
      lastPushError: out.ok ? '' : out.errors.join(' | ').slice(0, 200),
    })
    log(out.ok ? `QQ 推送：已发送 ${out.sent} 条` : `QQ 推送失败：${out.errors.join(' | ')}`)
    return { ...out, at: when }
  } catch (err) {
    const message = String(err?.message ?? err)
    saveNotify(dir, { lastPushAt: when, lastPushOk: false, lastPushError: message.slice(0, 200) })
    log(`QQ 推送失败：${message}`)
    return { ok: false, sent: 0, errors: [message], at: when }
  }
}

/** 设置页「发送测试消息」用；配置不完整时直接抛错，让用户看到原因 */
export async function sendTestMessage(dir, { at = new Date().toISOString(), log = () => {} } = {}) {
  const notify = loadNotify(dir)
  if (!notify.enabled) throw new Error('推送还没启用：先勾选「启用推送」再保存')
  if (!notify.appId || !notify.appSecret) throw new Error('缺少机器人 AppID / AppSecret')
  if (!notify.target) throw new Error('缺少推送目标 openid')

  const text = `【Pixiv 同步 ${formatLocal(at)} · 测试】\n✅ 看到这条就说明 QQ 推送配置可用；以后每轮同步（定时或手动）结束都会发一条摘要。`
  const out = await sendQqText({ ...notify, text })
  saveNotify(dir, {
    lastPushAt: at,
    lastPushOk: out.ok,
    lastPushError: out.ok ? '' : out.errors.join(' | ').slice(0, 200),
  })
  if (!out.ok) throw new Error(out.errors.join(' | ') || '发送失败')
  log('QQ 测试消息已发送')
  return { ...out, at }
}

/** 给工具/设置页看的推送状态（不返回 appSecret） */
export function describeNotify(notify) {
  const state = notify.enabled ? '已启用' : '未启用'
  const target = notify.target || '(未填目标)'
  const secret = notify.appSecret ? '已保存' : '未填'
  const lines = [`QQ 推送：${state}，目标 ${target}，AppID ${notify.appId || '(未填)'}，AppSecret ${secret}`]
  if (notify.lastPushAt) {
    const mark = notify.lastPushOk === false ? `❌ 失败（${notify.lastPushError || '未知错误'}）` : '✅ 成功'
    lines.push(`上次推送：${formatLocal(notify.lastPushAt)} ${mark}`)
  }
  if (notify.enabled && !notifyReady(notify)) {
    lines.push('（配置不完整：需要同时填 AppID、AppSecret 和 openid，否则不会推送）')
  }
  return lines.join('\n')
}
