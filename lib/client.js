/**
 * dsh-pixiv-sync 的浏览器侧：在 DSH 设置里注册一个独立栏目（slot: settings.section）。
 *
 * 手写的 __ModuleLoader__ bundle，不需要构建工具。
 * 数据全部走同源 HTTP（/api/pixiv-sync/*），不碰 RPC。
 */

window.__ModuleLoader__.load({
  // 这个 id 必须等于 package.json 里的包名：宿主按包名建模块图，
  // 写成别的名字会找不到该行、回退重拉同一个 bundle，触发 duplicate factory registration。
  id: 'dsh-pixiv-autodownload',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState

    var API = '/api/pixiv-sync'

    // ---- 同源 API ---------------------------------------------------------

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (e) {
          data = null
        }
        if (!res.ok) {
          var msg = data && data.message ? data.message : 'HTTP ' + res.status
          throw new Error(msg)
        }
        return data
      })
    }

    function apiState() {
      return fetch(API + '/state', { cache: 'no-store' }).then(readJson)
    }

    function apiAction(body) {
      return fetch(API + '/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    // ---- 命名模板预览 -----------------------------------------------------

    var SAMPLE = { user: '画师名', uid: '12345678', id: '150214824', page: 0, title: '示例作品', date: '2026-01-01', type: 'illust' }

    function expand(tpl, vars) {
      return String(tpl || '').replace(/\{(\w+)\}/g, function (whole, key) {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] == null ? '' : vars[key]) : whole
      })
    }

    /** ISO 时间转成本地可读格式 */
    function fmtTime(iso) {
      if (!iso) return ''
      var d = new Date(iso)
      return isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.ps-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 28px; }',
      '.ps-head { font-size: 13px; color: var(--dsw-alias-text-secondary, #888); }',
      '.ps-h { font-size: 14px; font-weight: 600; margin: 6px 0 2px; }',
      '.ps-chips { display: flex; flex-wrap: wrap; gap: 8px; }',
      '.ps-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 4px 4px 12px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-accent, #4f7cf7) 14%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-accent, #4f7cf7) 38%, transparent); font-size: 13px; line-height: 1.5; }',
      '.ps-chip.off { opacity: .45; }',
      '.ps-chip .id { color: var(--dsw-alias-text-secondary, #888); font-variant-numeric: tabular-nums; }',
      '.ps-chip button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 5px; border-radius: 999px; }',
      '.ps-chip button:hover { background: rgba(128,128,128,.22); }',
      '.ps-chip-btn { font-size: 12px; line-height: 1.6; padding: 2px 8px; min-width: 26px; text-align: center; border-radius: 999px; border: 0; background: rgba(128,128,128,.18); color: inherit; cursor: pointer; font-family: "Segoe UI Symbol", "Segoe UI", sans-serif; }',
      '.ps-chip-btn:hover { background: rgba(128,128,128,.34); }',
      '.ps-chip-btn.danger:hover { background: rgba(221,51,51,.22); color: #e05a5a; }',
      '.ps-radio { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; font-size: 13px; }',
      '.ps-radio label { display: flex; gap: 6px; align-items: center; cursor: pointer; }',
      '.ps-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
      '.ps-input { box-sizing: border-box; width: 100%; max-width: 460px; height: 34px; padding: 6px 11px; border-radius: 8px; border: 1px solid var(--dsw-alias-border, #8886); background: transparent; color: inherit; font: inherit; font-size: 13px; }',
      '.ps-row > .ps-input { flex: 1 1 280px; max-width: none; }',
      '.ps-input:focus, .ps-area:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-accent, #4f7cf7) 55%, transparent); outline-offset: -1px; }',
      '.ps-card { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border, #8883); border-radius: 12px; }',
      '.ps-btn { padding: 6px 16px; border: 0; border-radius: 8px; background: var(--dsw-alias-accent, #4f7cf7); color: #fff; font: inherit; font-size: 13px; cursor: pointer; }',
      '.ps-btn:disabled { opacity: .5; cursor: default; }',
      '.ps-btn.ghost { background: transparent; color: inherit; border: 1px solid var(--dsw-alias-border, #8886); }',
      '.ps-note { font-size: 12px; color: var(--dsw-alias-text-secondary, #888); }',
      '.ps-note.ok { color: var(--dsw-alias-text-success, #1a9c63); }',
      '.ps-note.err { color: var(--dsw-alias-text-danger, #d33); }',
      '.ps-field { display: flex; flex-direction: column; gap: 6px; }',
      '.ps-label { font-size: 12px; color: var(--dsw-alias-text-secondary, #888); }',
      '.ps-token { font: 12px ui-monospace, Consolas, monospace; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border, #8886); background: transparent; color: inherit; cursor: pointer; }',
      '.ps-token:hover { background: rgba(128,128,128,.18); }',
      '.ps-token-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
      '.ps-mono { font: 12px/1.5 ui-monospace, Consolas, monospace; }',
      '.ps-narrow { width: 100%; max-width: 460px; }',
      '.ps-preview { font: 12px/1.6 ui-monospace, Consolas, monospace; color: var(--dsw-alias-text-secondary, #888); word-break: break-all; background: rgba(128,128,128,.09); border-radius: 8px; padding: 7px 10px; }',
      '.ps-area { box-sizing: border-box; width: 100%; max-width: 520px; min-height: 60px; padding: 8px 11px; border-radius: 8px; border: 1px solid var(--dsw-alias-border, #8886); background: transparent; color: inherit; font: 12px/1.5 ui-monospace, Consolas, monospace; resize: vertical; }',
    ].join('\n')

    // ---- 组件 -------------------------------------------------------------

    function Section() {
      var [state, setState] = useState(null)
      var [input, setInput] = useState('')
      var [busy, setBusy] = useState(false)
      var [note, setNote] = useState(null)
      var [time, setTime] = useState('09:00')
      var [enabled, setEnabled] = useState(false)
      var [folder, setFolder] = useState('{user}-{uid}')
      var [fileTpl, setFileTpl] = useState('{id}_p{page}-{title}')
      var [outDir, setOutDir] = useState('')
      var [cookie, setCookie] = useState('')
      var [runMode, setRunMode] = useState('new')
      var [runLimit, setRunLimit] = useState('0')

      var apply = useCallback(function (s) {
        setState(s)
        if (!s) return
        setTime(s.schedule.time)
        setEnabled(s.schedule.enabled)
        setFolder(s.config.folderTemplate)
        setFileTpl(s.config.fileTemplate)
        setOutDir(s.config.outputDir)
      }, [])

      var load = useCallback(function () {
        return apiState()
          .then(function (r) {
            apply(r.state)
          })
          .catch(function (e) {
            setNote({ err: true, text: '读取失败：' + e.message })
          })
      }, [apply])

      useEffect(function () {
        load()
      }, [load])

      // 同步进行中时每 3 秒刷新一次状态
      var syncRunning = !!(state && state.sync && state.sync.running)
      useEffect(
        function () {
          if (!syncRunning) return
          var t = setInterval(function () {
            load()
          }, 3000)
          return function () {
            clearInterval(t)
          }
        },
        [syncRunning, load]
      )

      var send = useCallback(
        function (body, okText, at) {
          setBusy(true)
          setNote(null)
          return apiAction(body)
            .then(function (r) {
              if (r.state) apply(r.state)
              setNote({ ok: true, text: okText || r.message || '已保存', at: at || '' })
            })
            .catch(function (e) {
              setNote({ err: true, text: e.message, at: at || '' })
            })
            .then(function () {
              setBusy(false)
            })
        },
        [apply]
      )

      if (state === null) {
        return h('div', { className: 'ps-root' }, h('div', { className: 'ps-note' }, '读取中…'))
      }

      var mb = state.totals.bytes / 1024 / 1024 / 1024

      function inlineNote(at) {
        if (!note || note.at !== at) return null
        return h('div', { className: 'ps-note ' + (note.err ? 'err' : 'ok') }, note.text)
      }

      function tk(label, onClick) {
        return h(
          'button',
          { key: label, type: 'button', className: 'ps-token', disabled: busy, onClick: onClick },
          label
        )
      }

      return h(
        'div',
        { className: 'ps-root' },
        h('div', { className: 'ps-note' }, '按你指定的画师自动下载 Pixiv 新作品，下过的自动跳过。'),
        h(
          'div',
          { className: 'ps-head' },
          '画师 ' + state.artists.length + ' 位 · 作品 ' + state.totals.works + ' · 文件 ' + state.totals.files + ' · ' + mb.toFixed(2) + ' GB · 登录态：' + (state.hasCookie ? '已配置' : '未配置（只看公开作品）')
        ),
        note
          ? h('div', { className: 'ps-note ' + (note.err ? 'err' : 'ok') }, note.text)
          : null,

        h('div', { className: 'ps-h' }, '画师'),
        h(
          'div',
          { className: 'ps-chips' },
          state.artists.length === 0
            ? h('div', { className: 'ps-note' }, '还没有画师，下面输入 ID 或主页链接。')
            : state.artists.map(function (a) {
                return h(
                  'span',
                  { key: a.id, className: 'ps-chip' + (a.enabled ? '' : ' off') },
                  h('span', { title: '作品 ' + a.works + '，文件 ' + a.files + '，上次同步 ' + (fmtTime(a.lastSync) || '从未') }, a.name || '未命名'),
                  h('span', { className: 'id' }, String(a.id)),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ps-chip-btn',
                      title: a.enabled ? '暂停这个画师的同步（记录保留，随时恢复）' : '恢复这个画师的同步',
                      disabled: busy,
                      onClick: function () {
                        send({ action: 'toggle', id: a.id }, a.enabled ? '已暂停 ' + (a.name || a.id) : '已恢复 ' + (a.name || a.id), 'artist')
                      },
                    },
                    a.enabled ? '⏸' : '▶'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ps-chip-btn danger',
                      title: '从名单里删掉；已经下载的图不会被删除',
                      disabled: busy,
                      onClick: function () {
                        send({ action: 'remove', id: a.id }, '已移除 ' + (a.name || a.id) + '（下载记录保留）', 'artist')
                      },
                    },
                    '✕'
                  )
                )
              })
        ),
        inlineNote('artist'),
        h(
          'div',
          { className: 'ps-row' },
          h('input', {
            className: 'ps-input',
            value: input,
            placeholder: '画师 ID，或直接粘 https://www.pixiv.net/users/12345678',
            onChange: function (e) {
              setInput(e.target.value)
            },
            onKeyDown: function (e) {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (input.trim()) send({ action: 'add', artists: input }, '', 'artist')
                setInput('')
              }
            },
          }),
          h(
            'button',
            {
              className: 'ps-btn',
              type: 'button',
              disabled: busy || !input.trim(),
              onClick: function () {
                var v = input
                setInput('')
                send({ action: 'add', artists: v }, '', 'artist')
              },
            },
            busy ? '处理中…' : '添加'
          )
        ),
        h('div', { className: 'ps-note' }, '支持一次粘多个，用空格、逗号或换行分隔。名字会自动从 pixiv 反查。'),
        h(
          'div',
          { className: 'ps-note' },
          '⏸ 暂停这个画师（记录保留，点 ▶ 恢复，以后不会重下）；✕ 是从名单移除，已经下好的图不会被删。鼠标停在名字上能看到作品数和上次同步时间。'
        ),

        h('div', { className: 'ps-h' }, '同步'),
        h(
          'div',
          { className: 'ps-radio' },
          h(
            'label',
            null,
            h('input', {
              type: 'radio',
              name: 'ps-runmode',
              checked: runMode === 'new',
              onChange: function () {
                setRunMode('new')
              },
            }),
            '只下新的（增量）'
          ),
          h(
            'label',
            null,
            h('input', {
              type: 'radio',
              name: 'ps-runmode',
              checked: runMode === 'full',
              onChange: function () {
                setRunMode('full')
              },
            }),
            '补齐历史（慢，会回头扫全部作品）'
          )
        ),
        h(
          'div',
          { className: 'ps-row' },
          h('span', { className: 'ps-note' }, '每个画师最多新增'),
          h('input', {
            className: 'ps-input',
            inputMode: 'numeric',
            style: { flex: '0 0 84px', width: '84px', minWidth: '84px', maxWidth: '84px', textAlign: 'center' },
            value: runLimit,
            onChange: function (e) {
              setRunLimit(e.target.value.replace(/[^\d]/g, ''))
            },
          }),
          h('span', { className: 'ps-note' }, '个作品（0 = 不限）'),
          h(
            'button',
            {
              className: 'ps-btn',
              type: 'button',
              disabled: busy || syncRunning,
              onClick: function () {
                send(
                  { action: 'run', full: runMode === 'full', limit: Number(runLimit) || 0 },
                  runMode === 'full' ? '已开始补齐历史，跑完会显示结果' : '已开始增量同步，跑完会显示结果',
                  'sync'
                )
              },
            },
            syncRunning ? '同步中…' : '立即同步'
          )
        ),
        h(
          'div',
          { className: 'ps-note' },
          syncRunning
            ? '同步中… 开始于 ' + fmtTime(state.sync.startedAt) + '，完成后这里会显示结果。'
            : state.sync.message || '还没手动同步过。定时到点也会自动跑。'
        ),
        inlineNote('sync'),

        h('div', { className: 'ps-h' }, '定时'),
        h(
          'div',
          { className: 'ps-row' },
          h('input', {
            type: 'time',
            className: 'ps-input',
            style: { flex: '0 0 150px', minWidth: '130px' },
            value: time,
            onChange: function (e) {
              setTime(e.target.value)
            },
          }),
          h(
            'label',
            { className: 'ps-note', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: function (e) {
                setEnabled(e.target.checked)
              },
            }),
            '启用每日同步'
          ),
          h(
            'button',
            {
              className: 'ps-btn',
              type: 'button',
              disabled: busy,
              onClick: function () {
                send({ action: 'schedule', time: time, enabled: enabled }, '定时已保存：每天 ' + time + '，' + (enabled ? '已启用' : '已停用'), 'schedule')
              },
            },
            '保存'
          )
        ),
        inlineNote('schedule'),
        h(
          'div',
          { className: 'ps-note' },
          '上次自动运行：' +
            (fmtTime(state.schedule.lastRunAt) || '从未') +
            (state.schedule.lastResult
              ? ' · 新增 ' + state.schedule.lastResult.works + ' 个作品 / ' + state.schedule.lastResult.files + ' 张，失败 ' + state.schedule.lastResult.failed
              : '') +
            '。只在 DSH 运行期间触发。'
        ),

        h('div', { className: 'ps-h' }, '命名'),

        h(
          'div',
          { className: 'ps-field' },
          h('span', { className: 'ps-label' }, '目录（一个画师一个文件夹）'),
          h('input', {
            className: 'ps-input ps-narrow ps-mono',
            value: folder,
            onChange: function (e) {
              setFolder(e.target.value)
            },
          }),
          h(
            'div',
            { className: 'ps-token-row' },
            tk('{user}', function () {
              setFolder(folder + '{user}')
            }),
            tk('{uid}', function () {
              setFolder(folder + '{uid}')
            }),
            tk('默认 {user}-{uid}', function () {
              setFolder('{user}-{uid}')
            })
          )
        ),

        h(
          'div',
          { className: 'ps-field' },
          h('span', { className: 'ps-label' }, '文件名（不含扩展名）'),
          h('input', {
            className: 'ps-input ps-narrow ps-mono',
            value: fileTpl,
            onChange: function (e) {
              setFileTpl(e.target.value)
            },
          }),
          h(
            'div',
            { className: 'ps-token-row' },
            tk('{id}', function () {
              setFileTpl(fileTpl + '{id}')
            }),
            tk('_p{page}', function () {
              setFileTpl(fileTpl + '_p{page}')
            }),
            tk('-{title}', function () {
              setFileTpl(fileTpl + '-{title}')
            }),
            tk('{user}', function () {
              setFileTpl(fileTpl + '{user}')
            }),
            tk('{uid}', function () {
              setFileTpl(fileTpl + '{uid}')
            }),
            tk('{date}', function () {
              setFileTpl(fileTpl + '{date}')
            }),
            tk('{type}', function () {
              setFileTpl(fileTpl + '{type}')
            }),
            tk('默认 {id}_p{page}-{title}', function () {
              setFileTpl('{id}_p{page}-{title}')
            })
          )
        ),

        h('div', { className: 'ps-preview' }, '预览：' + (outDir || '(默认目录)') + '\\' + expand(folder, SAMPLE) + '\\' + expand(fileTpl, SAMPLE) + '.jpg'),

        h(
          'div',
          { className: 'ps-field' },
          h('span', { className: 'ps-label' }, '输出目录'),
          h(
            'div',
            { className: 'ps-row' },
            h('input', {
              className: 'ps-input ps-narrow ps-mono',
              value: outDir,
              onChange: function (e) {
                setOutDir(e.target.value)
              },
            }),
            h(
              'button',
              {
                className: 'ps-btn ghost',
                type: 'button',
                disabled: busy,
                onClick: function () {
                  setBusy(true)
                  setNote(null)
                  apiAction({ action: 'pickdir' })
                    .then(function (r) {
                      if (r.state) apply(r.state)
                      setNote({ ok: true, text: r.message })
                    })
                    .catch(function (e) {
                      setNote({ err: true, text: e.message })
                    })
                    .then(function () {
                      setBusy(false)
                    })
                },
              },
              '选择…'
            )
          )
        ),

        h(
          'div',
          { className: 'ps-row' },
          h(
            'button',
            {
              className: 'ps-btn',
              type: 'button',
              disabled: busy,
              onClick: function () {
                send({ action: 'naming', folderTemplate: folder, fileTemplate: fileTpl, outputDir: outDir }, '命名规则已保存', 'naming')
              },
            },
            '保存命名'
          ),
          h('span', { className: 'ps-note' }, '点上面的气泡追加占位符；只影响之后新下的文件。')
        ),
        inlineNote('naming'),

        h('div', { className: 'ps-h' }, 'Cookie'),
        h(
          'div',
          { className: 'ps-note' },
          state.hasCookie
            ? '当前状态：已保存 cookie（存在本机 cookie.txt），可以下 R18 和私密作品。要换新的，粘到下面再保存一次。'
            : '当前状态：没有 cookie，只能看公开作品。取法：Edge 打开 pixiv 并登录 → F12 → Application（应用）→ Storage → Cookies → https://www.pixiv.net → 找 PHPSESSID → 复制 Value。'
        ),
        h('textarea', {
          className: 'ps-area',
          value: cookie,
          spellCheck: false,
          placeholder: 'PHPSESSID=...（也可以直接粘整条 Cookie 请求头）',
          onChange: function (e) {
            setCookie(e.target.value)
          },
        }),
        h(
          'div',
          { className: 'ps-row' },
          h(
            'button',
            {
              className: 'ps-btn',
              type: 'button',
              disabled: busy || !cookie.trim(),
              onClick: function () {
                var v = cookie
                setCookie('')
                send({ action: 'cookie', cookie: v }, 'cookie 已保存，之后就能下 R18 和私密作品了', 'cookie')
              },
            },
            '保存 cookie'
          )
        ),
        inlineNote('cookie'),

        h('div', { className: 'ps-h' }, '维护'),
        h(
          'div',
          { className: 'ps-row' },
          h(
            'button',
            {
              className: 'ps-btn ghost',
              type: 'button',
              disabled: busy,
              onClick: function () {
                send({ action: 'adopt' }, '扫描完成', 'adopt')
              },
            },
            '扫描已有文件补记录'
          )
        ),
        h(
          'div',
          { className: 'ps-note' },
          '扫一遍输出目录，把硬盘上已经有、但库里没记录的图片补进数据库，避免下次重复下载。换电脑、重装 DSH、手动拷过文件之后点一次。目录名要符合「名字-ID」，文件名要以「作品ID_p页号」开头，否则认不出来。'
        ),
        inlineNote('adopt')
      )
    }

    /** 设置页错误边界：崩了也要看得见原因 */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        console.error('[dsh-pixiv-sync] 设置页渲染失败：', error)
      }
      render() {
        if (this.state.error) {
          var msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'ps-root' }, h('div', { className: 'ps-note err' }, '设置页渲染出错：' + msg))
        }
        return this.props.children
      }
    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-pixiv-autodownload-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-pixiv-sync: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'pixiv-autodownload',
            order: 48,
            label: function () {
              return 'Pixiv 自动下载'
            },
          },
          function (props) {
            return h(ErrorBoundary, null, h(Section, props || {}))
          }
        )
      })
    }

    module.exports = {
      name: 'pixiv-autodownload',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
