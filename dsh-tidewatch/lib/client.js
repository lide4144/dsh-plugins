/**
 * dsh-tidewatch —— DeepSeek 高峰/低谷时段与账户余额面板（浏览器半侧）。
 *
 * 形态与本机既有的 dsh-raw-html 一致：手工维护的 __ModuleLoader__ bundle，
 * 不含 JSX、无构建步骤，改完 node --check 校验语法 + 刷新页面即生效。
 *
 * 职责：
 * 1. 在页面右上方渲染一张可拖拽、可折叠的悬浮卡片：时段状态灯（高峰/低谷）、
 *    北京时钟、到下一时段的倒计时。时段判定全部在本地按官方规则计算，不经 Host。
 * 2. 显示当前生效的模型与 provider，并按 provider 自动取用其已配置的凭据查询
 *    余额——正常情况下无需手动填 Key；也保留手动输入作为显式覆盖。
 *
 * 数据源由 Host 的 /dsh-tidewatch 通道给出：浏览器侧只拿到「凭据引用名、
 * 是否可用、来源」与余额数值，永远拿不到 Key 本身。
 *
 * 时段规则（DeepSeek 官方定价页）：高峰 = 北京时间周一至周五 09:00–12:00、
 * 14:00–18:00；其余全部为空闲（低谷）时段，价格为高峰的一半。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tidewatch',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    /** 与 Host 共享的 loopback RPC 通道。 */
    var ROUTE = '/api/dsh-tidewatch'
    /** 客户端半边版本号：显示在卡片底部，用于快速确认浏览器里跑的是哪一版。 */
    var VERSION = '1.2'
    /** 北京时区偏移（UTC+8）。 */
    var BJ_OFFSET = 8 * 3600 * 1000
    /** 悬浮卡片根节点 id（同时用于幂等挂载）。 */
    var ROOT_ID = 'dsh-tidewatch-root'
    /** 样式节点 id。 */
    var STYLE_ID = 'dsh-tidewatch-style'
    /** 余额自动刷新间隔。 */
    var REFRESH_MS = 5 * 60 * 1000
    /** 默认停靠位置（距右边缘 / 距顶部的像素）。 */
    var DEFAULT_RIGHT = 16
    var DEFAULT_TOP = 72
    /** 「手动输入」伪 provider id，与 Host 侧常量一致。 */
    var MANUAL = 'manual'

    var CSS = [
      '.dst-root{position:fixed;z-index:9000;pointer-events:auto;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.dst-card{width:312px;background:rgba(255,255,255,.94);border:1px solid rgba(0,0,0,.08);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);overflow:hidden;backdrop-filter:blur(10px);color:#1f2937}',
      '.dst-header{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;user-select:none;touch-action:none}',
      '.dst-dot{width:10px;height:10px;border-radius:50%;flex:none}',
      '.dst-peak{background:#ef4444;box-shadow:0 0 6px #ef4444}',
      '.dst-off{background:#10b981;box-shadow:0 0 6px #10b981}',
      '.dst-title{font-weight:700;font-size:13px}',
      '.dst-tag{font-size:10px;font-weight:700;color:#059669;background:#d1fae5;padding:1px 6px;border-radius:999px}',
      '.dst-clock{margin-left:auto;font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums}',
      '.dst-mini{border:none;background:transparent;color:#6b7280;cursor:pointer;font-size:13px;padding:0 4px;border-radius:6px}',
      '.dst-mini:hover{background:rgba(0,0,0,.06)}',
      '.dst-body{padding:2px 10px 10px}',
      '.dst-row{display:flex;align-items:baseline;gap:6px;margin:2px 0}',
      '.dst-count-label{font-size:12px;color:#4b5563}',
      '.dst-count{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.dst-hint{font-size:11px;color:#6b7280;line-height:1.5}',
      '.dst-mono{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
      '.dst-divider{height:1px;background:rgba(0,0,0,.08);margin:6px 0}',
      '.dst-keyrow{display:flex;gap:6px;margin:4px 0;align-items:center;flex-wrap:wrap}',
      '.dst-input{flex:1;min-width:0;border:1px solid rgba(0,0,0,.15);border-radius:8px;padding:4px 8px;font-size:12px;background:rgba(255,255,255,.8);color:#1f2937}',
      '.dst-select{flex:1;min-width:0;border:1px solid rgba(0,0,0,.15);border-radius:8px;padding:3px 6px;font-size:12px;background:rgba(255,255,255,.8);color:#1f2937}',
      '.dst-btn{border:1px solid rgba(0,0,0,.15);background:rgba(0,0,0,.04);border-radius:8px;padding:3px 10px;font-size:12px;cursor:pointer;color:#1f2937}',
      '.dst-btn:hover{background:rgba(0,0,0,.08)}',
      '.dst-btn:disabled{opacity:.5;cursor:default}',
      '.dst-keystat{font-size:12px;color:#059669;flex:1;min-width:0}',
      '.dst-err{font-size:12px;color:#dc2626;overflow-wrap:anywhere}',
      '.dst-msg-ok{font-size:11px;color:#059669}',
      '.dst-msg-err{font-size:11px;color:#dc2626}',
      '.dst-balance{display:flex;flex-direction:column;gap:4px}',
      '.dst-avail{font-size:11px;font-weight:700}',
      '.dst-ok{color:#059669}',
      '.dst-bad{color:#dc2626}',
      '.dst-binforow{display:flex;align-items:baseline;gap:8px;font-size:12px}',
      '.dst-cur{font-weight:700;font-size:10px;color:#6b7280}',
      '.dst-total{font-weight:800;font-size:15px;font-variant-numeric:tabular-nums}',
      '.dst-sub{font-size:11px;color:#6b7280}',
      '.dst-refreshrow{display:flex;align-items:center;justify-content:space-between;margin-top:2px}',
      '@media (prefers-color-scheme: dark){',
      '.dst-card{background:rgba(24,26,32,.94);border-color:rgba(255,255,255,.1);color:#e5e7eb}',
      '.dst-input,.dst-select{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.15);color:#e5e7eb}',
      '.dst-btn{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.15);color:#e5e7eb}',
      '.dst-btn:hover{background:rgba(255,255,255,.12)}',
      '.dst-clock,.dst-hint,.dst-sub,.dst-cur{color:#9ca3af}',
      '.dst-count-label{color:#d1d5db}',
      '.dst-divider{background:rgba(255,255,255,.1)}',
      '.dst-mini{color:#9ca3af}',
      '.dst-mini:hover{background:rgba(255,255,255,.1)}',
      '}',
    ].join('\n')

    // ---- 时段计算 --------------------------------------------------------

    function pad(n) {
      return String(n).padStart(2, '0')
    }

    /**
     * 计算给定时刻的时段与下一次切换时刻。
     * @param nowMs - 毫秒时间戳。
     * @returns {{ isPeak: boolean, nextTransitionMs: number, bjTime: Date }} 时段状态。
     */
    function computePeriod(nowMs) {
      var b = new Date(nowMs + BJ_OFFSET)
      var day = b.getUTCDay()
      var mins = b.getUTCHours() * 60 + b.getUTCMinutes()
      var isWeekday = day >= 1 && day <= 5
      var morningPeak = mins >= 540 && mins < 720
      var afternoonPeak = mins >= 840 && mins < 1080
      var isPeak = isWeekday && (morningPeak || afternoonPeak)

      var next = new Date(b.getTime())
      if (isPeak) {
        next.setUTCHours(morningPeak ? 12 : 18, 0, 0, 0)
      } else {
        var target = null
        if (isWeekday && mins < 540) target = 9
        else if (isWeekday && mins < 840) target = 14
        if (target === null) {
          next.setUTCHours(0, 0, 0, 0)
          var d0 = next.getUTCDay()
          var add = 1
          if (d0 === 5) add = 3
          else if (d0 === 6) add = 2
          next.setUTCDate(next.getUTCDate() + add)
          next.setUTCHours(9, 0, 0, 0)
        } else {
          next.setUTCHours(target, 0, 0, 0)
        }
      }

      return {
        isPeak: isPeak,
        nextTransitionMs: next.getTime() - BJ_OFFSET,
        bjTime: b,
      }
    }

    /** 剩余时长的人类可读文本。 */
    function fmtSpan(ms) {
      var s = Math.max(0, Math.floor(ms / 1000))
      var h = Math.floor(s / 3600)
      var m = Math.floor((s % 3600) / 60)
      var sec = s % 60
      if (h > 0) return h + '小时' + m + '分' + sec + '秒'
      if (m > 0) return m + '分' + sec + '秒'
      return sec + '秒'
    }

    function fmtClock(ms) {
      var d = new Date(ms)
      return pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    // ---- DOM 小工具 ------------------------------------------------------

    function el(tag, className, text) {
      var node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    }

    function clearNode(node) {
      while (node.firstChild) node.removeChild(node.firstChild)
    }

    // ---- 宿主调用 --------------------------------------------------------

    /**
     * 调用 Host 路由。
     *
     * 走同源 fetch 而不是 connection.rpc：后者在当前构建的宿主里无法注册路由
     * （HostConnectionService 的 ctx 缺少 webServer 注入，rpc.handle 必然抛错）。
     * 同源请求自动携带会话 cookie，Host/Origin 校验与浏览器鉴权由 /api 载体统一施加；
     * 也因此不再依赖「connection 服务是否已就绪」这一时序条件。
     * @param endpoint - 端点名。
     * @param payload - JSON 负载。
     * @returns {Promise<object>} 解包后的结果。
     */
    function rpcCall(endpoint, payload) {
      return window.fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ endpoint: endpoint, payload: payload || {} }),
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      }).then(function (body) {
        return body && body.value !== undefined ? body.value : body
      })
    }

    // ---- 插件主体 --------------------------------------------------------

    /**
     * 插件入口：挂载悬浮卡片。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      // 幂等：重复激活时先移除旧节点（HMR / 多次 apply 都不会叠卡片）
      var stale = document.getElementById(ROOT_ID)
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale)

      ctx.effect(function () {
        var style = document.getElementById(STYLE_ID)
        if (!style) {
          style = el('style')
          style.id = STYLE_ID
          style.textContent = CSS
          document.head.appendChild(style)
        }

        var state = {
          catalog: null,
          selected: null,
          manualEditing: false,
          balance: null,
          collapsed: false,
        }

        // --- 结构 ---
        var root = el('div', 'dst-root')
        root.id = ROOT_ID
        root.style.right = DEFAULT_RIGHT + 'px'
        root.style.top = DEFAULT_TOP + 'px'

        var card = el('div', 'dst-card')
        var header = el('div', 'dst-header')
        var dot = el('span', 'dst-dot dst-off')
        var title = el('span', 'dst-title', '—')
        var tag = el('span', 'dst-tag', '半价')
        var clock = el('span', 'dst-clock', '')
        var minBtn = el('button', 'dst-mini', '－')
        minBtn.title = '收起'
        header.appendChild(dot)
        header.appendChild(title)
        header.appendChild(tag)
        header.appendChild(clock)
        header.appendChild(minBtn)

        var body = el('div', 'dst-body')
        var row = el('div', 'dst-row')
        var countLabel = el('span', 'dst-count-label', '')
        var count = el('span', 'dst-count', '')
        row.appendChild(countLabel)
        row.appendChild(count)
        var hint = el('div', 'dst-hint', '高峰: 工作日 09:00–12:00 / 14:00–18:00（北京时间），低谷时段价格减半')
        var divider = el('div', 'dst-divider')
        var modelLine = el('div', 'dst-hint dst-mono', '')
        var keyBox = el('div', 'dst-keybox')
        var msgBox = el('div', 'dst-msgbox')
        var balanceBox = el('div', 'dst-balance')
        var footer = el('div', 'dst-hint', 'dsh-tidewatch v' + VERSION)
        body.appendChild(row)
        body.appendChild(hint)
        body.appendChild(divider)
        body.appendChild(modelLine)
        body.appendChild(keyBox)
        body.appendChild(msgBox)
        body.appendChild(balanceBox)
        body.appendChild(footer)

        card.appendChild(header)
        card.appendChild(body)
        root.appendChild(card)

        // --- 拖拽 ---
        var drag = null
        header.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return
          drag = {
            px: e.clientX,
            py: e.clientY,
            right: parseFloat(root.style.right) || DEFAULT_RIGHT,
            top: parseFloat(root.style.top) || DEFAULT_TOP,
          }
          try {
            header.setPointerCapture(e.pointerId)
          } catch (err) {
            // 指针捕获在部分环境下不可用；拖拽仍按普通事件流工作。
          }
          e.preventDefault()
        })
        header.addEventListener('pointermove', function (e) {
          if (!drag) return
          var nr = drag.right - (e.clientX - drag.px)
          var nt = drag.top + (e.clientY - drag.py)
          root.style.right = Math.max(-200, Math.min(nr, 1200)) + 'px'
          root.style.top = Math.max(0, Math.min(nt, 1600)) + 'px'
        })
        function endDrag() {
          drag = null
        }
        header.addEventListener('pointerup', endDrag)
        header.addEventListener('pointercancel', endDrag)

        // --- 折叠 ---
        minBtn.addEventListener('pointerdown', function (e) {
          e.stopPropagation()
        })
        minBtn.addEventListener('click', function () {
          state.collapsed = !state.collapsed
          body.style.display = state.collapsed ? 'none' : 'block'
          minBtn.textContent = state.collapsed ? '＋' : '－'
          minBtn.title = state.collapsed ? '展开' : '收起'
        })

        // --- 渲染 ---
        function setMsg(kind, text) {
          clearNode(msgBox)
          if (!text) return
          msgBox.appendChild(el('div', kind === 'ok' ? 'dst-msg-ok' : 'dst-msg-err', text))
        }

        function candidates() {
          return (state.catalog && state.catalog.candidates) || []
        }

        function candidateOf(provider) {
          var list = candidates()
          for (var i = 0; i < list.length; i++) {
            if (list[i].provider === provider) return list[i]
          }
          return null
        }

        function renderModelLine() {
          var active = state.catalog && state.catalog.active
          if (!active) {
            modelLine.textContent = '未读取到模型配置（Host 未响应）'
            return
          }
          modelLine.textContent = '模型 ' + (active.model || '(未指定)') + ' · ' + active.provider
        }

        function renderKey() {
          clearNode(keyBox)
          var list = candidates()
          var manualRow = candidateOf(MANUAL)
          var manualMode = list.length === 0 || state.selected === MANUAL

          if (list.length > 0) {
            var select = el('select', 'dst-select')
            for (var i = 0; i < list.length; i++) {
              var row = list[i]
              if (row.provider === MANUAL) continue
              var opt = document.createElement('option')
              opt.value = row.provider
              opt.textContent = row.displayName +
                (row.active ? '（当前模型）' : '') +
                (row.hasKey ? '' : ' · 无 Key')
              select.appendChild(opt)
            }
            var manualOpt = document.createElement('option')
            manualOpt.value = MANUAL
            manualOpt.textContent = manualRow ? '手动输入（已保存）' : '手动输入…'
            select.appendChild(manualOpt)
            select.value = manualMode ? MANUAL : state.selected
            select.addEventListener('change', function () {
              state.selected = select.value
              state.manualEditing = false
              setMsg(null, null)
              renderKey()
              if (state.selected !== MANUAL) loadBalance()
            })
            keyBox.appendChild(select)
          }

          if (!manualMode) {
            var current = candidateOf(state.selected)
            if (current && current.keyRef) {
              keyBox.appendChild(el('span', 'dst-hint dst-mono', '凭据 ' + current.keyRef + '（' + (current.keySource || 'unknown') + '）'))
            }
            return
          }

          if (manualRow && !state.manualEditing) {
            keyBox.appendChild(el('span', 'dst-keystat', '✓ 已保存手动 Key'))
            var changeBtn = el('button', 'dst-btn', '更换')
            changeBtn.addEventListener('click', function () {
              state.manualEditing = true
              setMsg(null, null)
              renderKey()
            })
            var clearBtn = el('button', 'dst-btn', '清除')
            clearBtn.addEventListener('click', doClearKey)
            keyBox.appendChild(changeBtn)
            keyBox.appendChild(clearBtn)
            return
          }

          var input = el('input', 'dst-input')
          input.type = 'password'
          input.placeholder = 'sk-...'
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') doSaveKey(input.value)
          })
          var saveBtn = el('button', 'dst-btn', '保存')
          saveBtn.addEventListener('click', function () {
            doSaveKey(input.value)
          })
          keyBox.appendChild(input)
          keyBox.appendChild(saveBtn)
          if (manualRow) {
            var cancelBtn = el('button', 'dst-btn', '取消')
            cancelBtn.addEventListener('click', function () {
              state.manualEditing = false
              setMsg(null, null)
              renderKey()
            })
            keyBox.appendChild(cancelBtn)
          }
        }

        function renderBalance() {
          clearNode(balanceBox)
          var b = state.balance
          if (!b) return

          if (b.status === 'loading') {
            balanceBox.appendChild(el('div', 'dst-hint', '查询中…'))
            return
          }
          if (b.status === 'error') {
            balanceBox.appendChild(el('div', 'dst-err', '查询失败: ' + b.error))
            return
          }
          if (b.status !== 'ok') return

          var d = b.data || {}
          var infos = Array.isArray(d.balance_infos) ? d.balance_infos : []
          var head = el('div', 'dst-avail ' + (d.is_available ? 'dst-ok' : 'dst-bad'),
            (d.is_available ? '● 账户可用' : '● 账户不可用') + (b.displayName ? ' · ' + b.displayName : ''))
          balanceBox.appendChild(head)

          for (var i = 0; i < infos.length; i++) {
            var info = infos[i] || {}
            var infoRow = el('div', 'dst-binforow')
            infoRow.appendChild(el('span', 'dst-cur', info.currency))
            infoRow.appendChild(el('span', 'dst-total', info.total_balance))
            infoRow.appendChild(el('span', 'dst-sub', '充值 ' + info.topped_up_balance + ' · 赠送 ' + info.granted_balance))
            balanceBox.appendChild(infoRow)
          }

          var refreshRow = el('div', 'dst-refreshrow')
          refreshRow.appendChild(el('span', 'dst-hint', b.fetchedAt ? '更新于 ' + fmtClock(b.fetchedAt) : ''))
          var refreshBtn = el('button', 'dst-btn', '刷新')
          refreshBtn.addEventListener('click', loadBalance)
          refreshRow.appendChild(refreshBtn)
          balanceBox.appendChild(refreshRow)
        }

        // --- 数据 ---
        function loadBalance() {
          state.balance = { status: 'loading' }
          renderBalance()
          var payload = state.selected ? { provider: state.selected } : {}
          rpcCall('fetch-balance', payload).then(function (res) {
            if (res && res.error) {
              state.balance = { status: 'error', error: res.error }
            } else if (!res || !res.balance) {
              state.balance = { status: 'error', error: '未返回余额数据' }
            } else {
              state.balance = {
                status: 'ok',
                data: res.balance,
                displayName: res.displayName || null,
                fetchedAt: Date.now(),
              }
            }
            renderBalance()
          }).catch(function (err) {
            state.balance = { status: 'error', error: (err && err.message) || String(err) }
            renderBalance()
          })
        }

        function loadCatalog() {
          rpcCall('status', {}).then(function (res) {
            state.catalog = res || null
            if (state.selected === null || !candidateOf(state.selected)) {
              state.selected = res && res.selected ? res.selected : null
            }
            renderModelLine()
            renderKey()
            loadBalance()
          }).catch(function (err) {
            modelLine.textContent = '读取模型配置失败: ' + ((err && err.message) || String(err))
          })
        }

        function doSaveKey(raw) {
          var key = (raw || '').trim()
          if (!key) {
            setMsg('err', '请输入 API Key')
            return
          }
          rpcCall('save-key', { key: key }).then(function (res) {
            if (res && res.ok) {
              state.manualEditing = false
              state.selected = MANUAL
              setMsg('ok', '已保存（仅存于本机凭据文件）')
              loadCatalog()
            } else {
              setMsg('err', (res && res.error && res.error.message) || '保存失败')
            }
          }).catch(function (err) {
            setMsg('err', (err && err.message) || String(err))
          })
        }

        function doClearKey() {
          rpcCall('clear-key', {}).then(function (res) {
            if (res && res.ok) {
              state.manualEditing = false
              state.selected = null
              setMsg('ok', '已清除')
              loadCatalog()
            } else {
              setMsg('err', (res && res.error && res.error.message) || '清除失败')
            }
          }).catch(function (err) {
            setMsg('err', (err && err.message) || String(err))
          })
        }

        // --- 时钟 ---
        function tick() {
          var now = Date.now()
          var p = computePeriod(now)
          dot.className = 'dst-dot ' + (p.isPeak ? 'dst-peak' : 'dst-off')
          title.textContent = p.isPeak ? '高峰期' : '低谷期'
          tag.style.display = p.isPeak ? 'none' : ''
          var bj = p.bjTime
          clock.textContent = '北京 周' + '日一二三四五六'[bj.getUTCDay()] + ' ' +
            pad(bj.getUTCHours()) + ':' + pad(bj.getUTCMinutes()) + ':' + pad(bj.getUTCSeconds())
          countLabel.textContent = p.isPeak ? '距低谷期还有' : '距高峰期还有'
          count.textContent = fmtSpan(p.nextTransitionMs - now)
        }

        document.body.appendChild(root)
        renderKey()
        renderBalance()
        tick()
        loadCatalog()

        var clockTimer = window.setInterval(tick, 1000)
        var refreshTimer = window.setInterval(function () {
          if (state.selected) loadBalance()
        }, REFRESH_MS)

        return function () {
          window.clearInterval(clockTimer)
          window.clearInterval(refreshTimer)
          if (root.parentNode) root.parentNode.removeChild(root)
          var s = document.getElementById(STYLE_ID)
          if (s && s.parentNode) s.parentNode.removeChild(s)
        }
      }, 'dsh-tidewatch: widget')
    }

    exports.apply = apply
    return module.exports
  },
})
