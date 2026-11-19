/**
 * 主动发 QQ 消息（走 QQ 官方机器人 HTTP API，不经过 dsh-qq-notify，也不依赖 WebSocket）。
 *
 * 和 dsh-checkin 的 qqPush.js 是同一套做法：先拿 app access token，
 * 再往 /v2/users/{openid}/messages（私聊）或 /v2/groups/{openid}/messages（群）发文本。
 * 受 QQ 主动消息频控限制，失败时只记日志，不影响同步结果。
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const BASE_URL = 'https://api.bot.qq.com'
const MAX_CHUNK = 900

let cached = { token: '', expiresAt: 0, key: '' }

export function parseTarget(raw) {
  const text = String(raw ?? '').trim()
  const index = text.indexOf(':')
  if (index < 0) throw new Error(`target 格式错误，需要 c2c:<openid> 或 group:<openid>，收到: ${text}`)
  const scope = text.slice(0, index).trim().toLowerCase()
  const id = text.slice(index + 1).trim()
  if (scope !== 'c2c' && scope !== 'group') throw new Error(`target 前缀只能是 c2c 或 group，收到: ${scope}`)
  if (!id) throw new Error('target 缺少 openid')
  return { scope, id }
}

/** QQ 平台会拦截含 URL 的文本（40034028），改写成纯文本。 */
export function sanitizeText(text) {
  return String(text ?? '')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)]+\)/gi, '$1')
    .replace(/(?:https?:\/\/|www\.)[^\s，。)）」'"]+/gi, '（链接已省略）')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\/[^\s，。)）」'"]+/gi, '（链接已省略）')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

async function getAccessToken(appId, appSecret) {
  const key = `${appId}:${appSecret}`
  if (cached.token && cached.key === key && Date.now() < cached.expiresAt - 60_000) {
    return cached.token
  }
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`getAppAccessToken HTTP ${response.status}: ${raw.slice(0, 200)}`)
  const data = JSON.parse(raw)
  if (!data?.access_token) throw new Error(`getAppAccessToken 缺 access_token: ${raw.slice(0, 200)}`)
  const expiresIn = Number(data.expires_in ?? 7200)
  cached = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000, key }
  return data.access_token
}

function chunks(text) {
  const result = []
  let rest = String(text ?? '')
  while (rest.length > 0) {
    if (rest.length <= MAX_CHUNK) {
      result.push(rest)
      break
    }
    let cut = rest.lastIndexOf('\n', MAX_CHUNK)
    if (cut <= 0) cut = MAX_CHUNK
    result.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  return result
}

/**
 * 发一条（或分片多条）QQ 文本消息。
 * @param {{appId:string, appSecret:string, target:string, text:string}} options
 * @returns {Promise<{ok:boolean, sent:number, errors:string[]}>}
 */
export async function sendQqText({ appId, appSecret, target, text }) {
  if (!appId || !appSecret) throw new Error('缺少推送机器人的 appId / appSecret')
  const { scope, id } = parseTarget(target)
  const token = await getAccessToken(appId, appSecret)
  const path =
    scope === 'c2c'
      ? `/v2/users/${encodeURIComponent(id)}/messages`
      : `/v2/groups/${encodeURIComponent(id)}/messages`
  const errors = []
  let sent = 0
  for (const piece of chunks(sanitizeText(text))) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: piece, msg_type: 0 }),
        signal: AbortSignal.timeout(20_000),
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(`send HTTP ${response.status}: ${raw.slice(0, 200)}`)
      sent += 1
    } catch (error) {
      errors.push(String(error?.message ?? error))
    }
  }
  return { ok: errors.length === 0, sent, errors }
}
