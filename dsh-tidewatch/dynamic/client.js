// dsh-tidewatch — Client half
// DeepSeek Harness dynamic Cordis plugin: floating peak/off-peak + balance widget.
// Paste this file's body into `code.client` of cordis_define (plain JS, no imports).

const BJ_OFFSET = 8 * 3600 * 1000

const CSS = `
.dsx-root{position:fixed;z-index:9000;pointer-events:auto;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.dsx-card{width:304px;background:rgba(255,255,255,.94);border:1px solid rgba(0,0,0,.08);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);overflow:hidden;backdrop-filter:blur(10px);color:#1f2937}
.dsx-header{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;user-select:none;touch-action:none}
.dsx-dot{width:10px;height:10px;border-radius:50%;flex:none}
.dsx-peak{background:#ef4444;box-shadow:0 0 6px #ef4444}
.dsx-off{background:#10b981;box-shadow:0 0 6px #10b981}
.dsx-title{font-weight:700;font-size:13px}
.dsx-tag{font-size:10px;font-weight:700;color:#059669;background:#d1fae5;padding:1px 6px;border-radius:999px}
.dsx-clock{margin-left:auto;font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums}
.dsx-mini{border:none;background:transparent;color:#6b7280;cursor:pointer;font-size:13px;padding:0 4px;border-radius:6px}
.dsx-mini:hover{background:rgba(0,0,0,.06)}
.dsx-body{padding:2px 10px 10px}
.dsx-row{display:flex;align-items:baseline;gap:6px;margin:2px 0}
.dsx-count-label{font-size:12px;color:#4b5563}
.dsx-count{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.dsx-hint{font-size:11px;color:#6b7280;line-height:1.5}
.dsx-divider{height:1px;background:rgba(0,0,0,.08);margin:6px 0}
.dsx-keyrow{display:flex;gap:6px;margin:4px 0;align-items:center}
.dsx-input{flex:1;min-width:0;border:1px solid rgba(0,0,0,.15);border-radius:8px;padding:4px 8px;font-size:12px;background:rgba(255,255,255,.8);color:#1f2937}
.dsx-btn{border:1px solid rgba(0,0,0,.15);background:rgba(0,0,0,.04);border-radius:8px;padding:3px 10px;font-size:12px;cursor:pointer;color:#1f2937}
.dsx-btn:hover{background:rgba(0,0,0,.08)}
.dsx-btn:disabled{opacity:.5;cursor:default}
.dsx-keystat{font-size:12px;color:#059669;flex:1}
.dsx-err{font-size:12px;color:#dc2626}
.dsx-msg-ok{font-size:11px;color:#059669}
.dsx-msg-err{font-size:11px;color:#dc2626}
.dsx-balance{display:flex;flex-direction:column;gap:4px}
.dsx-avail{font-size:11px;font-weight:700}
.dsx-ok{color:#059669}
.dsx-bad{color:#dc2626}
.dsx-binforow{display:flex;align-items:baseline;gap:8px;font-size:12px}
.dsx-cur{font-weight:700;font-size:10px;color:#6b7280}
.dsx-total{font-weight:800;font-size:15px;font-variant-numeric:tabular-nums}
.dsx-sub{font-size:11px;color:#6b7280}
.dsx-refreshrow{display:flex;align-items:center;justify-content:space-between;margin-top:2px}
@media (prefers-color-scheme: dark){
.dsx-card{background:rgba(24,26,32,.94);border-color:rgba(255,255,255,.1);color:#e5e7eb}
.dsx-input{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.15);color:#e5e7eb}
.dsx-btn{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.15);color:#e5e7eb}
.dsx-btn:hover{background:rgba(255,255,255,.12)}
.dsx-clock,.dsx-hint,.dsx-sub,.dsx-cur{color:#9ca3af}
.dsx-count-label{color:#d1d5db}
.dsx-divider{background:rgba(255,255,255,.1)}
.dsx-mini{color:#9ca3af}
.dsx-mini:hover{background:rgba(255,255,255,.1)}
}
`

function pad(n) {
  return String(n).padStart(2, '0')
}

function computePeriod(nowMs) {
  const b = new Date(nowMs + BJ_OFFSET)
  const day = b.getUTCDay()
  const mins = b.getUTCHours() * 60 + b.getUTCMinutes()
  const isWeekday = day >= 1 && day <= 5
  const morningPeak = mins >= 540 && mins < 720
  const afternoonPeak = mins >= 840 && mins < 1080
  const isPeak = isWeekday && (morningPeak || afternoonPeak)
  const next = new Date(b.getTime())
  if (isPeak) {
    next.setUTCHours(morningPeak ? 12 : 18, 0, 0, 0)
  } else {
    let target = null
    if (isWeekday && mins < 540) target = 9
    else if (isWeekday && mins < 840) target = 14
    if (target === null) {
      next.setUTCHours(0, 0, 0, 0)
      const d0 = next.getUTCDay()
      let add = 1
      if (d0 === 5) add = 3
      else if (d0 === 6) add = 2
      next.setUTCDate(next.getUTCDate() + add)
      next.setUTCHours(9, 0, 0, 0)
    } else {
      next.setUTCHours(target, 0, 0, 0)
    }
  }
  return {
    isPeak,
    nextTransitionMs: next.getTime() - BJ_OFFSET,
    nextIsPeak: !isPeak,
    bjTime: b,
  }
}

function fmtSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return h + '小时' + m + '分' + sec + '秒'
  if (m > 0) return m + '分' + sec + '秒'
  return sec + '秒'
}

function fmtClock(ms) {
  const d = new Date(ms)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

return {
  inject: ['timer'],
  apply(ctx) {
    styles.insert(CSS)
    const slots = ctx.get('slots')
    if (slots === undefined) return

    let drag = null

    function Widget() {
      const [now, setNow] = React.useState(() => Date.now())
      const [pos, setPos] = React.useState({ x: 16, y: 72 })
      const [collapsed, setCollapsed] = React.useState(false)
      const [keyStatus, setKeyStatus] = React.useState(null)
      const [keyInput, setKeyInput] = React.useState('')
      const [showKeyInput, setShowKeyInput] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [balance, setBalance] = React.useState(null)

      async function loadBalance() {
        setBalance({ status: 'loading' })
        try {
          const res = await host.call('ds-fetch-balance')
          if (!res || !res.configured) setBalance({ status: 'nokey' })
          else if (res.error) setBalance({ status: 'error', error: res.error })
          else setBalance({ status: 'ok', data: res.balance, fetchedAt: Date.now() })
        } catch (error) {
          setBalance({ status: 'error', error: error && error.message ? error.message : String(error) })
        }
      }

      React.useEffect(() => {
        host.call('ds-status').then((s) => setKeyStatus(s)).catch(() => setKeyStatus({ configured: false, source: null }))
        loadBalance()
      }, [])

      React.useEffect(() => ctx.interval(() => setNow(Date.now()), 1000), [])

      React.useEffect(() => ctx.interval(() => {
        host.call('ds-fetch-balance').then((res) => {
          if (res && res.configured && !res.error) {
            setBalance({ status: 'ok', data: res.balance, fetchedAt: Date.now() })
          }
        }).catch(() => {})
      }, 5 * 60 * 1000), [])

      function dragStart(e) {
        if (e.button !== undefined && e.button !== 0) return
        drag = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
        e.preventDefault()
      }
      function dragMove(e) {
        if (!drag) return
        const nx = drag.x - (e.clientX - drag.px)
        const ny = drag.y + (e.clientY - drag.py)
        setPos({ x: Math.max(-200, Math.min(nx, 1200)), y: Math.max(0, Math.min(ny, 1600)) })
      }
      function dragEnd() {
        drag = null
      }

      async function saveKey() {
        const key = keyInput.trim()
        if (!key) { setMsg({ kind: 'err', text: '请输入 API Key' }); return }
        setBusy(true)
        try {
          const res = await host.call('ds-save-key', { key })
          if (res && res.ok) {
            setKeyInput('')
            setShowKeyInput(false)
            setMsg({ kind: 'ok', text: '已保存（仅存于本机凭据文件）' })
            const st = await host.call('ds-status')
            setKeyStatus(st)
            loadBalance()
          } else {
            setMsg({ kind: 'err', text: (res && res.error) || '保存失败' })
          }
        } catch (error) {
          setMsg({ kind: 'err', text: error && error.message ? error.message : String(error) })
        }
        setBusy(false)
      }

      async function clearKey() {
        setBusy(true)
        try {
          const res = await host.call('ds-clear-key')
          if (res && res.ok) {
            setMsg({ kind: 'ok', text: '已清除' })
            setKeyStatus({ configured: false, source: null })
            setBalance({ status: 'nokey' })
          } else {
            setMsg({ kind: 'err', text: (res && res.error) || '清除失败' })
          }
        } catch (error) {
          setMsg({ kind: 'err', text: error && error.message ? error.message : String(error) })
        }
        setBusy(false)
      }

      const el = React.createElement
      const p = computePeriod(now)
      const bj = p.bjTime
      const week = '日一二三四五六'[bj.getUTCDay()]
      const clock = pad(bj.getUTCHours()) + ':' + pad(bj.getUTCMinutes()) + ':' + pad(bj.getUTCSeconds())
      const hasKey = !!keyStatus && keyStatus.configured

      let keySection
      if (!hasKey || showKeyInput) {
        keySection = el('div', { className: 'dsx-keyrow' },
          el('input', {
            className: 'dsx-input',
            type: 'password',
            placeholder: 'sk-...',
            value: keyInput,
            onChange: (e) => setKeyInput(e.target.value),
          }),
          el('button', { className: 'dsx-btn', disabled: busy, onClick: saveKey }, '保存'),
          hasKey ? el('button', { className: 'dsx-btn', disabled: busy, onClick: () => { setShowKeyInput(false); setKeyInput('') } }, '取消') : null,
        )
      } else {
        keySection = el('div', { className: 'dsx-keyrow' },
          el('span', { className: 'dsx-keystat' }, '✓ Key 已配置' + (keyStatus.source === 'env' ? '（环境变量）' : '（已保存）')),
          el('button', { className: 'dsx-btn', disabled: busy, onClick: () => setShowKeyInput(true) }, '更换'),
          el('button', { className: 'dsx-btn', disabled: busy, onClick: clearKey }, '清除'),
        )
      }

      let balanceSection = null
      if (!balance) balanceSection = null
      else if (balance.status === 'loading') balanceSection = el('div', { className: 'dsx-hint' }, '查询中…')
      else if (balance.status === 'nokey') balanceSection = el('div', { className: 'dsx-hint' }, '未配置 API Key，输入后可查询余额')
      else if (balance.status === 'error') balanceSection = el('div', { className: 'dsx-err' }, '查询失败: ' + balance.error)
      else if (balance.status === 'ok') {
        const d = balance.data || {}
        const infos = Array.isArray(d.balance_infos) ? d.balance_infos : []
        balanceSection = el('div', { className: 'dsx-balance' },
          el('div', { className: 'dsx-avail ' + (d.is_available ? 'dsx-ok' : 'dsx-bad') }, d.is_available ? '● 账户可用' : '● 账户不可用'),
          infos.map((info, i) => el('div', { key: 'b' + i, className: 'dsx-binforow' },
            el('span', { className: 'dsx-cur' }, info.currency),
            el('span', { className: 'dsx-total' }, info.total_balance),
            el('span', { className: 'dsx-sub' }, '充值 ' + info.topped_up_balance + ' · 赠送 ' + info.granted_balance),
          )),
          el('div', { className: 'dsx-refreshrow' },
            balance.fetchedAt ? el('span', { className: 'dsx-hint' }, '更新于 ' + fmtClock(balance.fetchedAt)) : null,
            el('button', { className: 'dsx-btn', onClick: loadBalance }, '刷新'),
          ),
        )
      }

      return el('div', { className: 'dsx-root', style: { right: pos.x + 'px', top: pos.y + 'px' } },
        el('div', { className: 'dsx-card' },
          el('div', {
            className: 'dsx-header',
            onPointerDown: dragStart,
            onPointerMove: dragMove,
            onPointerUp: dragEnd,
            onPointerCancel: dragEnd,
          },
            el('span', { className: 'dsx-dot ' + (p.isPeak ? 'dsx-peak' : 'dsx-off') }),
            el('span', { className: 'dsx-title' }, p.isPeak ? '高峰期' : '低谷期'),
            p.isPeak ? null : el('span', { className: 'dsx-tag' }, '半价'),
            el('span', { className: 'dsx-clock' }, '北京 周' + week + ' ' + clock),
            el('button', {
              className: 'dsx-mini',
              title: collapsed ? '展开' : '收起',
              onPointerDown: (e) => e.stopPropagation(),
              onClick: () => setCollapsed(!collapsed),
            }, collapsed ? '＋' : '－'),
          ),
          collapsed ? null : el('div', { className: 'dsx-body' },
            el('div', { className: 'dsx-row' },
              el('span', { className: 'dsx-count-label' }, p.isPeak ? '距低谷期还有' : '距高峰期还有'),
              el('span', { className: 'dsx-count' }, fmtSpan(p.nextTransitionMs - now)),
            ),
            el('div', { className: 'dsx-hint' }, '高峰: 工作日 09:00–12:00 / 14:00–18:00（北京时间），低谷时段价格减半'),
            el('div', { className: 'dsx-divider' }),
            keySection,
            msg ? el('div', { className: msg.kind === 'ok' ? 'dsx-msg-ok' : 'dsx-msg-err' }, msg.text) : null,
            balanceSection,
          ),
        ),
      )
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'ds-tide-widget', label: 'DeepSeek 时段/余额', order: 0 },
      () => React.createElement(Widget),
    ))
  },
}
