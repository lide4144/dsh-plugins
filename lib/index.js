/**
 * dsh-quota-readout — host half.
 *
 * Periodically queries the quota/balance endpoint of the current default
 * model's provider and serves the latest snapshot as JSON over the webServer
 * route `/dsh-quotas/quota` (`?force=1` bypasses the 60 s cache).
 *
 * Supported providers (matched by substring of the provider id):
 *   - deepseek  → GET https://api.deepseek.com/user/balance
 *   - opencode  → GET https://opencode.ai/zen/go/v1/usage   (OpenCode Go subscription)
 *   - kimi      → GET https://api.kimi.com/coding/v1/usages (Kimi Code subscription)
 *
 * Credentials are resolved per request through the `credentials` service: the
 * env-var reference comes from the `llm-pi-ai` settings section
 * (`providers.<id>.apiKeyEnv`) with a per-provider fallback.
 *
 * HTTP is performed with curl through the `shell` service so the harness
 * sandbox policy applies; the API key travels via a per-exec environment
 * variable, never on the command line.
 *
 * @module dsh-quota-readout
 */

/** Cordis plugin name. */
const name = 'dsh-quota-readout'

/** webServer owns the JSON route; timer owns the periodic refresh. */
const inject = ['webServer', 'timer']

/** Route path the client half polls. */
const ROUTE_PATH = '/dsh-quotas/quota'
/** Cache lifetime before a poll re-fetches upstream. */
const CACHE_MS = 60_000
/** Background refresh cadence. */
const REFRESH_MS = 180_000

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseDeepSeek(body) {
  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : []
  if (infos.length === 0) throw new Error('响应中没有 balance_infos')
  return {
    plan: 'DeepSeek API 余额',
    items: infos.map((info) => ({
      label: '余额 ' + String(info.currency || ''),
      text: String(info.total_balance),
      detail: '赠送 ' + String(info.granted_balance) + ' · 充值 ' + String(info.topped_up_balance),
      percent: null,
      resetAt: null,
    })),
  }
}

function parseOpenCodeGo(body) {
  const usage = body && body.usage ? body.usage : {}
  const defs = [['rolling', '5小时'], ['weekly', '每周'], ['monthly', '每月']]
  const items = []
  for (const def of defs) {
    const w = usage[def[0]]
    if (w && typeof w.percent === 'number') {
      items.push({
        label: def[1],
        text: '已用 ' + w.percent + '%',
        detail: w.status && w.status !== 'ok' ? w.status : null,
        percent: w.percent,
        resetAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
      })
    }
  }
  if (items.length === 0) throw new Error('响应中没有 usage 窗口')
  return { plan: 'OpenCode Go 订阅', items }
}

function windowLabel(win) {
  if (!win) return '限额'
  const d = toNum(win.duration)
  const unit = win.timeUnit
  if (d === null) return '限额'
  if (unit === 'TIME_UNIT_MINUTE') return d % 60 === 0 ? String(d / 60) + '小时限额' : String(d) + '分钟限额'
  if (unit === 'TIME_UNIT_HOUR') return String(d) + '小时限额'
  if (unit === 'TIME_UNIT_DAY') return String(d) + '天限额'
  return '限额'
}

function quotaItem(label, detail) {
  const used = toNum(detail.used)
  const limit = toNum(detail.limit)
  const percent = used !== null && limit ? Math.round((used / limit) * 1000) / 10 : null
  return {
    label,
    text: percent !== null ? '已用 ' + percent + '%' : (used !== null && limit !== null ? String(used) + ' / ' + String(limit) : '数据不完整'),
    detail: used !== null && limit !== null ? String(used) + ' / ' + String(limit) : null,
    percent,
    resetAt: typeof detail.resetTime === 'string' ? detail.resetTime : null,
  }
}

function parseKimi(body) {
  const items = []
  if (body && body.usage) items.push(quotaItem('每周额度', body.usage))
  const limits = body && Array.isArray(body.limits) ? body.limits : []
  for (const entry of limits) {
    if (entry && entry.detail) items.push(quotaItem(windowLabel(entry.window), entry.detail))
  }
  if (items.length === 0) throw new Error('响应中没有 usage 数据')
  return { plan: 'Kimi Code 订阅', items }
}

const FETCHERS = [
  { match: 'opencode', env: 'OPENCODE_GO_API_KEY', url: 'https://opencode.ai/zen/go/v1/usage', parse: parseOpenCodeGo },
  { match: 'kimi', env: 'KIMI_CODING_API_KEY', url: 'https://api.kimi.com/coding/v1/usages', parse: parseKimi },
  { match: 'deepseek', env: 'DEEPSEEK_API_KEY', url: 'https://api.deepseek.com/user/balance', parse: parseDeepSeek },
]

function fetcherFor(provider) {
  const p = String(provider || '').toLowerCase()
  for (const f of FETCHERS) {
    if (p.includes(f.match)) return f
  }
  return null
}

function apply(ctx) {
  const shell = ctx.get('shell')
  const creds = ctx.get('credentials')
  const settings = ctx.get('settings')
  const adm = ctx.get('agentDefaultModel')
  const agentsSvc = ctx.get('agents')
  const policySvc = ctx.get('sandboxPolicy')

  function envFor(provider, fetcher) {
    try {
      const cfg = settings ? settings.get('llm-pi-ai') : undefined
      const entry = cfg && cfg.providers ? cfg.providers[provider] : undefined
      if (entry && typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv) return entry.apiKeyEnv
    } catch (e) { /* fall back to default */ }
    return fetcher.env
  }

  function pickSession() {
    try {
      if (!agentsSvc) return null
      const roots = agentsSvc.roots()
      if (roots && roots.length > 0 && roots[0] && roots[0].session) return roots[0].session
      const all = agentsSvc.list()
      if (all && all.length > 0 && all[0] && all[0].session) return all[0].session
    } catch (e) { /* best effort */ }
    return null
  }

  function sessionCwd(session) {
    if (!session) return undefined
    const header = session.header || session.meta
    if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd
    return undefined
  }

  function executionExtras(request) {
    if (!policySvc) return
    const session = pickSession()
    const policy = session ? policySvc.resolve({ session }) : policySvc.resolve()
    request.sandboxPolicy = policy
    const cwd = sessionCwd(session)
    if (cwd) request.workdir = cwd
  }

  async function httpGetJson(url, apiKey) {
    if (!shell) throw new Error('shell 服务不可用')
    const request = {
      command: 'curl.exe -sS -m 20 -H "Authorization: Bearer $env:DSH_QUOTA_KEY" "' + url + '"',
      timeoutMs: 30000,
      env: { DSH_QUOTA_KEY: apiKey },
    }
    executionExtras(request)
    const spec = shell.resolve(request)
    const result = await shell.run(spec)
    if (result.exitCode !== 0) {
      const errText = result.stderr && result.stderr.text ? result.stderr.text.trim() : ''
      throw new Error('请求失败: ' + (errText || 'exit ' + result.exitCode).slice(0, 160))
    }
    const text = result.stdout && result.stdout.text ? result.stdout.text.trim() : ''
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error('响应不是 JSON: ' + text.slice(0, 120))
    }
  }

  let cache = null
  let inflight = null

  function refresh() {
    if (inflight) return inflight
    inflight = (async () => {
      const sel = adm ? adm.currentSelection() : null
      const provider = sel && sel.provider ? String(sel.provider) : ''
      const model = sel && sel.model ? String(sel.model) : ''
      const base = { provider, model, fetchedAt: new Date().toISOString() }
      try {
        const fetcher = fetcherFor(provider)
        if (!fetcher) {
          return { ...base, ok: false, error: '暂不支持 provider「' + (provider || '?') + '」的额度查询', plan: null, items: [] }
        }
        if (!creds) throw new Error('credentials 服务不可用')
        const envName = envFor(provider, fetcher)
        const resolved = await creds.resolve(envName)
        if (!resolved || !resolved.value) throw new Error('未找到凭证 ' + envName + '，请先在设置中配置')
        const body = await httpGetJson(fetcher.url, resolved.value)
        const parsed = fetcher.parse(body)
        return { ...base, ok: true, error: null, plan: parsed.plan, items: parsed.items }
      } catch (error) {
        return { ...base, ok: false, error: error && error.message ? error.message : String(error), plan: null, items: [] }
      }
    })()
    return inflight.then((snap) => {
      cache = snap
      inflight = null
      return snap
    }, (error) => {
      inflight = null
      throw error
    })
  }

  async function snapshot(force) {
    const stale = !cache || (Date.now() - Date.parse(cache.fetchedAt)) > CACHE_MS
    if (force || stale) return refresh()
    return cache
  }

  ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || ROUTE_PATH, 'http://localhost')
        const snap = await snapshot(url.searchParams.get('force') === '1')
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(snap))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error), items: [] }))
      }
    },
  })

  ctx.interval(() => {
    refresh().catch(() => {})
  }, REFRESH_MS)

  refresh().catch(() => {})

  ctx.on('credentials/updated', () => {
    cache = null
    refresh().catch(() => {})
  })
}

export { apply, inject, name }
