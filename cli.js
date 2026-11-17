#!/usr/bin/env node
/**
 * 命令行入口：给定时任务用，不依赖 DSH 运行。
 *
 *   node cli.js sync            同步所有启用画师（只下新的）
 *   node cli.js sync --limit 5  每个画师最多新增 5 个作品
 *   node cli.js sync --full     补历史缺口
 *   node cli.js status          查看统计
 *   node cli.js adopt           扫描输出目录补记录
 */

import {
  adoptExisting,
  getDataDir,
  loadConfig,
  openDb,
  readCookie,
  status,
  sync,
} from './lib/engine.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else out[key] = true
    } else out._.push(a)
  }
  return out
}

const fmtBytes = (b) => `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || 'sync'
  const dir = getDataDir()

  if (cmd === 'adopt') {
    const config = loadConfig(dir)
    const r = adoptExisting(openDb(dir), config.outputDir)
    console.log(`扫描完成：${r.artists} 个画师目录，${r.files} 个文件已入库`)
    return
  }

  if (cmd === 'status') {
    const s = status(dir)
    console.log(
      `画师 ${s.artists.length}，作品记录 ${s.totals.works}，文件记录 ${s.totals.files}，合计 ${fmtBytes(s.totals.bytes)}`
    )
    for (const a of s.artists) {
      console.log(
        `  ${a.enabled ? '✓' : '✗'} ${String(a.id).padEnd(10)} ${(a.name || '').padEnd(24)} 作品 ${String(a.works).padStart(5)}  文件 ${String(a.files).padStart(6)}  上次同步 ${a.last_sync_at || '从未'}`
      )
    }
    return
  }

  if (cmd !== 'sync') {
    console.error(`未知命令：${cmd}`)
    process.exit(1)
  }

  const config = loadConfig(dir)
  if (!readCookie(dir, config)) {
    console.warn('⚠ 没有配置 cookie，只能同步公开作品（R18 / 私密作品看不到）')
  }

  const quiet = Boolean(args.quiet)
  const result = await sync({
    dir,
    only: (args.artists || '').split(',').map(Number).filter(Boolean),
    limit: Number(args.limit) || 0,
    full: Boolean(args.full),
    log: quiet ? () => {} : (m) => console.log(m),
  })

  console.log(
    `\n画师 ${result.artists}，新增作品 ${result.works}，新增图片 ${result.files}，跳过 ${result.skipped}，失败 ${result.failed}，共 ${(result.bytes / 1024 / 1024).toFixed(1)} MB，耗时 ${result.seconds}s`
  )
  // 机器可读的一行，方便定时任务提取
  console.log('RESULT ' + JSON.stringify(result))
  if (result.failed > 0) process.exitCode = 2
}

main().catch((err) => {
  console.error('运行失败：', err)
  process.exit(1)
})
